import { INTERACTION_SLOT_COUNT, type GeneratedReply, type InteractionEvent } from './interactionQueue';

export const defaultTestDanmaku = `[弹幕][小杰] 姐姐今天好漂亮啊//等待生成
[礼物][阿豪][玫瑰×5]//等待生成
[弹幕][小宇] 姐姐你有男朋友吗？//等待生成`;

export type TestDanmaku = { type: 'chat' | 'gift'; nickname: string; content: string; gift?: InteractionEvent['gift']; result?: GeneratedReply };

const testLines = (input: string): string[] => input.trim().split(/\r?\n/).filter(line => line.trim());
export const countTestDanmaku = (input: string): number => testLines(input).length;

export function parseTestDanmaku(input: string): TestDanmaku[] {
  const lines = testLines(input);
  if (lines.length < 1 || lines.length > INTERACTION_SLOT_COUNT) throw new Error(`请输入 1～${INTERACTION_SLOT_COUNT} 条弹幕或礼物，每条占一行`);
  return lines.map((line, index) => {
    const match = /^\[弹幕\]\[([^\]\r\n]+)\]\s*(.*?)\/\/(.*)$/.exec(line.trim());
    const giftMatch = /^\[礼物\]\[([^\]\r\n]+)\]\[([^\]\r\n]+)×(\d+)\]\s*\/\/(.*)$/.exec(line.trim());
    if ((!match || !match[1].trim() || !match[2].trim()) &&
        (!giftMatch || !giftMatch[1].trim() || !giftMatch[2].trim() || !Number.isSafeInteger(Number(giftMatch[3])) || Number(giftMatch[3]) < 1)) {
      throw new Error(`第 ${index + 1} 行格式错误，请使用：[弹幕][昵称] 内容//等待生成，或 [礼物][昵称][玫瑰×5]//等待生成`);
    }
    const speech = (match ? match[3] : giftMatch![4]).trim();
    return {
      type: match ? 'chat' : 'gift',
      nickname: (match ? match[1] : giftMatch![1]).trim(),
      content: match ? match[2].trim() : `${giftMatch![2].trim()}×${Number(giftMatch![3])}`,
      ...(match ? {} : { gift: { name: giftMatch![2].trim(), count: Number(giftMatch![3]), gift_id: '', combo_id: '', is_final: true } }),
      ...(!speech || ['等待生成', '生成中'].includes(speech) ? {} : {
        result: { speech, generation_mode: 'question', emotion: 'neutral', segments: [] },
      }),
    };
  });
}
