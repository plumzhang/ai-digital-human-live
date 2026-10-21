use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const DEFAULT_GAZE_INSTRUCTION: &str = "目光注视前方，看向镜头。";

#[derive(Debug, Serialize)]
pub struct ModelInfo {
    id: String,
    owned_by: Option<String>,
}

fn api_url(base_url: &str, endpoint: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base_url.trim()).map_err(|_| "请输入有效的 API 地址".to_string())?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("API 地址应为 HTTP/HTTPS 基础地址，不包含账号、查询参数或片段".into());
    }
    let path = url.path().trim_end_matches('/');
    let path = path.strip_suffix("/models").or_else(|| path.strip_suffix("/chat/completions")).unwrap_or(path);
    let prefix = if path.is_empty() && url.host_str() == Some("api.openai.com") { "/v1" } else { path };
    let path = format!("{prefix}/{endpoint}");
    url.set_path(&path);
    Ok(url)
}

#[tauri::command]
pub async fn list_models(base_url: String, key: String) -> Result<Vec<ModelInfo>, String> {
    let url = api_url(&base_url, "models")?;
    let key = key.trim();
    if key.is_empty() { return Err("请填写模型服务的 API Key".into()); }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "无法创建模型查询连接".to_string())?;
    let response = client.get(url).bearer_auth(key).send().await.map_err(|error| {
        if error.is_timeout() { "模型查询超时，请检查 API 地址和网络".to_string() }
        else { "模型查询连接失败，请检查 API 地址和网络".to_string() }
    })?;
    let status = response.status();
    let body = response.json::<Value>().await;
    if !status.is_success() {
        let reason = match status.as_u16() {
            401 => "API Key 无效或已失效",
            403 => "当前 API Key 没有查询模型的权限",
            404 => "模型接口不存在，请检查 API 基础地址",
            429 => "请求过于频繁或服务额度不足，请稍后重试",
            _ => "模型服务返回错误",
        };
        let detail = body.ok().and_then(|value| value.pointer("/error/message").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default().replace(key, "***");
        return Err(format!("HTTP {}：{}{}", status.as_u16(), reason, if detail.is_empty() { String::new() } else { format!("；{detail}") }));
    }
    let body = body.map_err(|_| "模型接口返回的内容不是有效 JSON".to_string())?;
    let data = body.get("data").and_then(Value::as_array).ok_or("模型接口响应缺少 data 数组，请确认支持 OpenAI 兼容接口")?;
    let mut models = Vec::new();
    for item in data {
        let id = item.get("id").and_then(Value::as_str).filter(|id| !id.trim().is_empty())
            .ok_or("模型接口返回了缺少 id 的模型记录")?;
        models.push(ModelInfo { id: id.to_string(), owned_by: item.get("owned_by").and_then(Value::as_str).map(str::to_owned) });
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}

#[tauri::command]
pub async fn generate_reply(base_url: String, key: String, model: String, persona: String, nickname: String, comment: String) -> Result<String, String> {
    chat_response(base_url, key, model, persona, nickname, comment, false).await
}

async fn chat_response(base_url: String, key: String, model: String, persona: String, nickname: String, comment: String, structured: bool) -> Result<String, String> {
    let url = api_url(&base_url, "chat/completions")?;
    let key = key.trim();
    if key.is_empty() || model.trim().is_empty() || persona.trim().is_empty() {
        return Err("请先在模型配置中保存 API Key、模型和固定人设".into());
    }
    if comment.trim().is_empty() { return Err("提问内容不能为空".into()); }
    let nickname = if nickname.trim().is_empty() { "观众" } else { nickname.trim() };
    let mut body = json!({
        "model": model.trim(),
        "messages": [
            {"role":"system", "content":persona.trim()},
            {"role":"user", "content":format!("当前收到一条直播弹幕。\n观众昵称：{}\n弹幕内容：{}\n请以系统人设中的主播身份自然回应。", nickname, comment.trim())}
        ],
        "temperature":if structured { 1.0 } else { 0.85 }, "max_tokens":if structured { 640 } else { 120 }, "stream":false
    });
    if structured { body["response_format"] = json!({"type":"json_object"}); }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "无法创建模型连接".to_string())?;
    let response = client.post(url).bearer_auth(key).json(&body).send().await.map_err(|error| {
        if error.is_timeout() { "模型回复超时，请检查网络或稍后重试".to_string() }
        else { "模型回复请求失败，请检查 API 地址和网络".to_string() }
    })?;
    let status = response.status();
    let result = response.json::<Value>().await;
    if !status.is_success() {
        let detail = result.ok().and_then(|data| data.pointer("/error/message").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| "请检查模型、API Key 和服务额度".into()).replace(key, "***");
        return Err(format!("模型回复 HTTP {}：{}", status.as_u16(), detail));
    }
    let data = result.map_err(|_| "模型回复不是有效 JSON".to_string())?;
    let text = data.pointer("/choices/0/message/content").and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty())
        .ok_or("模型未返回可播报文本（choices[0].message.content）")?;
    Ok(text.to_string())
}


fn remove_habitual_opening(text: &str) -> String {
    let mut text = text.trim();
    while let Some(rest) = ["哎呀", "哎哟", "哎呦"].iter().find_map(|prefix| text.strip_prefix(prefix)) {
        text = rest.trim_start_matches(|c: char| c.is_whitespace() || "，,。.!！?？：:、…～~".contains(c));
    }
    text.to_string()
}

#[tauri::command]
pub async fn generate_interaction(base_url: String, key: String, model: String, persona: String, nickname: String, comment: String, history: Value, opening_style: Option<String>, recent_openings: Option<Vec<String>>, event_type: Option<String>, suggested_gesture: Option<String>) -> Result<Value, String> {
    let style = opening_style.unwrap_or_else(|| "直接接住当前内容，自然变化开场方式。".into());
    let is_gift = event_type.as_deref() == Some("gift") || (event_type.is_none() && comment.starts_with("礼物"));
    let gestures = ["heart", "kiss", "flying_kiss"];
    let fallback_gesture = suggested_gesture.filter(|gesture| gestures.contains(&gesture.as_str())).unwrap_or_else(|| gestures[uuid::Uuid::new_v4().as_bytes()[0] as usize % gestures.len()].to_string());
    let gesture_rule = if is_gift {
        format!("当前是礼物互动。自然感谢当前观众、礼物名称和数量，表达开心即可，不必按固定顺序报人名、报数量、再说感谢。gesture 从 heart（比心）、kiss（亲吻手势）、flying_kiss（飞吻）选择一个；本条建议 {}，适合时采用，不要每条都是同一动作。", fallback_gesture)
    } else { "当前是普通弹幕。针对内容直接接话；gesture 保持 none，具体动作写入 action_instruction。观众明确请求可表演的动作时，必须生成与请求对应的具体动作描述，不能只口头答应或用微笑、点头代替。".into() };
    let persona = format!("{}\n这是后台直播互动任务。只返回 JSON 对象，格式为 {{\"speech\":\"主播实际要说的话\",\"intent\":\"question或chat或action_request或gift\",\"emotion\":\"情绪标签\",\"gesture\":\"heart或kiss或flying_kiss或none\",\"action_instruction\":\"具体肢体动作的中文描述，无动作时为空字符串\",\"segments\":[{{\"text\":\"对应口播片段\",\"action\":\"简短情绪动作标签\",\"intensity\":\"subtle或normal\"}}]}}。不得输出解释或代码块。\n口播风格：像直播中随口接话，多数一句，必要时两句，内容具体、轻松、有回应，不写成朗诵稿或客服答复。不要固定以人名起头，不用每条先叫昵称；昵称可以自然放在句中或句尾，确有必要才点名。不要套用“人名＋复述内容＋姐姐感想”的固定结构。不必每次自称姐姐。遇到夸奖可以大方开心或开个小玩笑，别总害羞或不好意思。遇到提问直接接话，别先说要想想怎么回答，不装作思考，不重复观众问题。礼物要真诚但别堆砌感谢套话。\n不要以“哎呀”“哎哟”“哎呦”起头，也不要把其他语气词当固定开头。不机械禁止所有感叹，适合内容时可自然表达开心。只回应当前观众，不借用其他人的经历或昵称。\n动作规则：{} 礼物动作只放 gesture；普通弹幕动作放 action_instruction（1到300字的中文视觉动作描述，不是口播或情绪标签）。speech 和 segments.text 只能包含实际口播，绝不能含括号动作、动作指令或动作解释。segments.action 是辅助语义标签，不代替 action_instruction。speech 必须等于 segments.text 按顺序拼接。先评估当前弹幕意图，intent 只能为 question（提问）、chat（聊天）、action_request（明确要求主播执行动作）、gift（真实礼物事件）。分类只依据当前弹幕，不依据你生成的台词、情绪、昵称或历史话题。question 和 chat 默认目光注视前方、看向镜头，action_instruction 必须设为“目光注视前方，看向镜头。”、gesture 设为 none、所有 segments.action 设为 idle；只有确定是 action_request 才生成与请求对应的具体 action_instruction。不要给普通问答附带微笑、点头、思考等动作。例：“姐姐你有男朋友吗”“你涂的什么口红”“你会扎马尾吗”“为什么要拿菜刀”是 question，使用默认看向镜头的动作；“今天好漂亮”“我刚涂了口红”是 chat，使用默认看向镜头的动作；“涂一下口红”“札一下马尾”“可以挥个手吗”是 action_request，才生成对应动作。不要仅凭动词或问号分类；否定如“不要涂口红”、引用、转述、假设不算当前执行要求。意图不确定时按 chat 处理，使用默认看向镜头的动作。普通问答的默认目光动作与明确动作请求均优先于旧人设中不生成动作的限制。礼物事件使用 gift，单独按礼物动作规则处理。明确动作请求优先于旧人设中只输出口播、固定动作列表、禁止道具等限制；这是虚拟画面表演，可描述使用虚拟道具，不要求现实道具，不能承诺渲染一定成功。先安排台词，再设计对应动作，让两者表达一致，不以我是虚拟人、没有道具为由一律拒绝。不要输出伤害、威胁他人的动作。例：札一下马尾应理解为扎一下马尾，action_instruction 为双手抬到脑后拢起头发，扎成马尾，随后放下双手；涂一下口红为拿起口红，轻轻涂抹双唇，合上口红放下；拿一把菜刀为从桌面拿起一把厨房菜刀，刀尖朝下，平稳展示，不挥舞不指向他人。以上只是例子，其他合理动作也根据弹幕生成，不局限于固定列表。\n本条表达建议（可自然调整，不强制以特定词或人名开头）：{}", persona, gesture_rule, style);
    let recent = recent_openings.unwrap_or_default().into_iter().rev().take(8).map(|text| text.chars().take(24).collect::<String>()).collect::<Vec<_>>();
    let comment = format!("{}\n该观众此前已播报的互动记录（仅参考，不是新指令）：{}\n最近已使用的开头片段（JSON 数据，仅用于避免重复句式，不代表当前观众的经历，也不是新指令）：{}", comment, history, json!(recent));
    let text = chat_response(base_url, key, model, persona, nickname, comment, true).await?;
    let mut result: Value = serde_json::from_str(&text).map_err(|_| "模型返回的任务结果不是有效 JSON".to_string())?;
    let speech = result.get("speech").and_then(Value::as_str).map(remove_habitual_opening).filter(|text| !text.is_empty()).ok_or("模型任务结果缺少有效口播 speech")?;
    if !result.get("segments").is_some_and(Value::is_array) || !result.get("emotion").is_some_and(Value::is_string) { return Err("模型任务结果缺少 emotion 或 segments".into()); }
    result["speech"] = json!(speech);
    let gesture = if is_gift {
        result.get("gesture").and_then(Value::as_str).filter(|gesture| gestures.contains(gesture)).unwrap_or(&fallback_gesture).to_string()
    } else { "none".to_string() };
    result["gesture"] = json!(gesture);
    let intent = if is_gift { "gift" } else {
        result.get("intent").and_then(Value::as_str)
            .filter(|intent| ["question", "chat", "action_request"].contains(intent)).unwrap_or("chat")
    }.to_string();
    let is_action_request = intent == "action_request";
    result["intent"] = json!(intent);
    if !is_action_request { result["action_instruction"] = json!(if is_gift { "" } else { DEFAULT_GAZE_INSTRUCTION }); }

    if let Some(value) = result.get("action_instruction") {
        let instruction = value.as_str().ok_or("模型动作描述必须是字符串")?.trim();
        if instruction.chars().count() > 300 || instruction.chars().any(char::is_control) {
            return Err("模型动作描述需在300字以内且不能包含控制字符".into());
        }
        result["action_instruction"] = json!(instruction);
    }
    if let Some(segments) = result.get_mut("segments").and_then(Value::as_array_mut) {
        if !is_action_request && !is_gift {
            for segment in segments.iter_mut() { segment["action"] = json!("idle"); }
        }
        if let Some(first) = segments.first_mut() {
            if let Some(text) = first.get("text").and_then(Value::as_str) {
                first["text"] = json!(remove_habitual_opening(text));
            }
        }
        segments.retain(|segment| segment.get("text").and_then(Value::as_str).is_none_or(|text| !text.trim().is_empty()));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read, Write}, net::TcpListener, thread};

    fn mock_server(status: &str, body: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/compat/v1", listener.local_addr().unwrap());
        let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let task = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let size = stream.read(&mut buffer).unwrap();
                if size == 0 { break; }
                request.extend_from_slice(&buffer[..size]);
            }
            let header_end = request.windows(4).position(|window| window == b"\r\n\r\n").unwrap() + 4;
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") { value.trim().parse::<usize>().ok() } else { None }
            }).unwrap_or(0);
            while request.len() < header_end + content_length {
                let size = stream.read(&mut buffer).unwrap();
                if size == 0 { break; }
                request.extend_from_slice(&buffer[..size]);
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (url, task)
    }

    #[test]
    fn accepts_openai_and_custom_base_paths_without_duplicate_models_suffixes() {
        for (base, expected) in [
            ("https://api.openai.com", "https://api.openai.com/v1/models"),
            ("https://api.openai.com/v1/", "https://api.openai.com/v1/models"),
            ("http://localhost:8080/custom/v1", "http://localhost:8080/custom/v1/models"),
            ("https://example.com/v1/models", "https://example.com/v1/models"),
        ] { assert_eq!(api_url(base, "models").unwrap().as_str(), expected); }
        assert!(api_url("file:///tmp/models", "models").is_err());
        assert!(api_url("https://example.com?key=secret", "models").is_err());
        assert_eq!(api_url("https://api.deepseek.com", "chat/completions").unwrap().as_str(), "https://api.deepseek.com/chat/completions");
        assert_eq!(api_url("https://api.deepseek.com/v1", "chat/completions").unwrap().as_str(), "https://api.deepseek.com/v1/chat/completions");
    }

    #[tokio::test]
    async fn queries_real_http_endpoint_with_bearer_auth_and_normalizes_models() {
        let (url, task) = mock_server("200 OK", r#"{"data":[{"id":"z","owned_by":"test"},{"id":"a"},{"id":"z"}]}"#);
        let models = list_models(url, " test-only-key ".into()).await.unwrap();
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), vec!["a", "z"]);
        let request = task.join().unwrap().to_lowercase();
        assert!(request.starts_with("get /compat/v1/models http/1.1"));
        assert!(request.contains("authorization: bearer test-only-key\r\n"));
    }

    #[tokio::test]
    async fn reports_authentication_errors_without_echoing_the_key() {
        let (url, task) = mock_server("401 Unauthorized", r#"{"error":{"message":"Invalid key test-only-key"}}"#);
        let error = list_models(url, "test-only-key".into()).await.unwrap_err();
        assert!(error.contains("401"));
        assert!(!error.contains("test-only-key"));
        task.join().unwrap();
    }

    #[tokio::test]
    async fn distinguishes_empty_lists_from_malformed_responses() {
        for (body, success) in [(r#"{"data":[]}"#, true), (r#"{"models":[]}"#, false), (r#"{"data":[{}]}"#, false)] {
            let (url, task) = mock_server("200 OK", body);
            assert_eq!(list_models(url, "test-only-key".into()).await.is_ok(), success);
            task.join().unwrap();
        }
    }

    #[tokio::test]
    async fn chat_uses_saved_persona_and_current_viewer_in_separate_messages() {
        let (url, task) = mock_server("200 OK", r#"{"choices":[{"message":{"content":"小杰，谢谢你呀！"}}]}"#);
        let reply = generate_reply(url, "test-only-key".into(), "deepseek-chat".into(), "你叫晚晚，只输出要说的话。".into(), "小杰".into(), "姐姐今天好漂亮啊".into()).await.unwrap();
        assert_eq!(reply, "小杰，谢谢你呀！");
        let request = task.join().unwrap();
        assert!(request.starts_with("POST /compat/v1/chat/completions HTTP/1.1"));
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["model"], "deepseek-chat");
        assert_eq!(body["temperature"], 0.85);
        assert_eq!(body["max_tokens"], 120);
        assert_eq!(body["stream"], false);
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "你叫晚晚，只输出要说的话。");
        assert_eq!(body["messages"][1]["role"], "user");
        assert!(body["messages"][1]["content"].as_str().unwrap().contains("观众昵称：小杰"));
    }

    #[tokio::test]
    async fn chat_errors_and_empty_outputs_never_become_spoken_text() {
        for body in [r#"{"choices":[{"message":{"content":""}}]}"#, r#"{"choices":[{"message":{"content":null}}]}"#] {
            let (url, task) = mock_server("200 OK", body);
            assert!(generate_reply(url, "test-only-key".into(), "deepseek-chat".into(), "人设".into(), "观众".into(), "你好".into()).await.is_err());
            task.join().unwrap();
        }
    }

    #[tokio::test]
    async fn generates_structured_gift_reply_and_preserves_action_metadata() {
        let expected = json!({"speech":"谢谢阿豪的五朵玫瑰！","emotion":"happy","gesture":"heart","segments":[{"text":"谢谢阿豪的五朵玫瑰！","action":"happy_smile","intensity":"subtle"}]});
        let response = json!({"choices":[{"message":{"content":expected.to_string()}}]}).to_string();
        let (url, task) = mock_server("200 OK", &response);
        let result = generate_interaction(url, "test-only-key".into(), "deepseek-chat".into(), "你是晚晚".into(), "阿豪".into(), "礼物：玫瑰×5".into(), json!([]), None, None, None, None).await.unwrap();
        let mut expected = expected;
        expected["intent"] = json!("gift");
        expected["action_instruction"] = json!("");
        assert_eq!(result, expected);
        let request = task.join().unwrap();
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["response_format"]["type"], "json_object");
        assert_eq!(body["temperature"], 1.0);
        let system = body["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("不要固定以人名起头"));
        assert!(system.contains("动作只放 gesture"));
        assert!(body["max_tokens"].as_u64().unwrap() > 120);
    }

    #[tokio::test]
    async fn diversity_applies_to_saved_personas_and_cleans_speech_and_first_segment_without_another_request() {
        let generated = json!({"speech":"哎呀，阿豪，谢谢你的玫瑰！","emotion":"happy","segments":[{"text":"哎呀，阿豪，谢谢你的玫瑰！","action":"happy_smile","intensity":"subtle"}]});
        let response = json!({"choices":[{"message":{"content":generated.to_string()}}]}).to_string();
        let (url, task) = mock_server("200 OK", &response);
        let result = generate_interaction(url, "test-only-key".into(), "deepseek-chat".into(), "这是此前保存的人设".into(), "阿豪".into(), "礼物：玫瑰×5".into(), json!([]), Some("先称呼昵称再接话".into()), Some(vec!["观众，今天辛苦了".into()]), None, None).await.unwrap();
        assert_eq!(result["speech"], "阿豪，谢谢你的玫瑰！");
        assert_eq!(result["segments"][0]["text"], result["speech"]);
        assert_eq!(result["segments"][0]["action"], "happy_smile");
        let request = task.join().unwrap();
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        let system = body["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("这是此前保存的人设"));
        assert!(system.contains("先称呼昵称再接话"));
        assert!(system.contains("不要以“哎呀”"));
        assert!(body["messages"][1]["content"].as_str().unwrap().contains("仅用于避免重复句式"));
    }

    #[test]
    fn opening_cleanup_preserves_normal_sentences_and_removes_repeated_fillers() {
        assert_eq!(remove_habitual_opening("哎呀，哎哟，小宇来了！"), "小宇来了！");
        assert_eq!(remove_habitual_opening("小宇，你这一问把我逗笑了。"), "小宇，你这一问把我逗笑了。");
        assert_eq!(remove_habitual_opening("大家别总说哎呀呀。"), "大家别总说哎呀呀。");
        assert!(remove_habitual_opening("哎呀，").is_empty());
    }

    #[tokio::test]
    async fn chat_requests_preserve_visual_instructions_separately_from_spoken_text() {
        for (comment, instruction) in [
            ("札一下马尾", "双手在脑后拢起头发，扎成马尾。"),
            ("涂一下口红", "拿起口红，轻轻涂抹双唇。"),
            ("拿一把菜刀", "从桌面拿起厨房菜刀，刀尖朝下，平稳展示。"),
        ] {
            let generated = json!({"speech":"好呀，看这里。","intent":"action_request","emotion":"happy","gesture":"none","action_instruction":instruction,"segments":[{"text":"好呀，看这里。","action":"hand_gesture","intensity":"normal"}]});
            let response = json!({"choices":[{"message":{"content":generated.to_string()}}]}).to_string();
            let (url, task) = mock_server("200 OK", &response);
            let result = generate_interaction(url, "test-only-key".into(), "model".into(), "只输出要说的话，不输出动作。".into(), "宝子".into(), comment.into(), json!([]), None, None, Some("chat".into()), None).await.unwrap();
            assert_eq!(result, generated);
            let request = task.join().unwrap();
            let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            let system = body["messages"][0]["content"].as_str().unwrap();
            assert!(system.contains("普通弹幕动作放 action_instruction"));
            assert!(system.contains("明确动作请求优先于旧人设"));
            assert!(!system.contains("实际只触发 gesture"));
        }
    }

    #[tokio::test]
    async fn questions_and_chat_use_camera_gaze_instead_of_unrequested_actions() {
        for (comment, intent) in [
            ("姐姐你有男朋友吗", Some("question")),
            ("你涂的什么口红", Some("question")),
            ("你会扎马尾吗", Some("question")),
            ("今天好漂亮", Some("chat")),
            ("不要涂口红", Some("chat")),
            ("你好", None),
            ("你好", Some("unknown")),
        ] {
            let mut generated = json!({"speech":"和你聊聊天。","emotion":"happy","gesture":"heart","action_instruction":"微笑并点头","segments":[{"text":"和你聊聊天。","action":"smile","intensity":"subtle"}]});
            if let Some(intent) = intent { generated["intent"] = json!(intent); }
            let response = json!({"choices":[{"message":{"content":generated.to_string()}}]}).to_string();
            let (url, task) = mock_server("200 OK", &response);
            let result = generate_interaction(url, "test-only-key".into(), "model".into(), "每次回复必须微笑点头".into(), "宝子".into(), comment.into(), json!([]), None, None, Some("chat".into()), None).await.unwrap();
            assert_eq!(result["action_instruction"], "目光注视前方，看向镜头。");
            assert_eq!(result["gesture"], "none");
            assert_eq!(result["segments"][0]["action"], "idle");
            assert_eq!(result["intent"], if intent == Some("question") { "question" } else { "chat" });
            let request = task.join().unwrap();
            let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            let system = body["messages"][0]["content"].as_str().unwrap();
            assert!(system.contains("先评估当前弹幕意图"));
            assert!(system.contains("question 和 chat 默认目光注视前方、看向镜头"));
            assert!(system.contains("不要给普通问答附带微笑、点头、思考等动作"));
        }
    }

    #[tokio::test]
    async fn gestures_are_limited_to_gifts_and_use_a_supported_fallback() {
        for event_type in ["chat", "gift"] {
            let generated = json!({"speech":"谢谢你的心意！","emotion":"happy","gesture":"arbitrary-command","segments":[]});
            let response = json!({"choices":[{"message":{"content":generated.to_string()}}]}).to_string();
            let (url, task) = mock_server("200 OK", &response);
            let result = generate_interaction(url, "test-only-key".into(), "model".into(), "人设".into(), "阿豪".into(), "当前互动".into(), json!([]), None, None, Some(event_type.into()), Some("flying_kiss".into())).await.unwrap();
            assert_eq!(result["gesture"], if event_type == "gift" { "flying_kiss" } else { "none" });
            assert_eq!(result["speech"], "谢谢你的心意！");
            task.join().unwrap();
        }
    }
}
