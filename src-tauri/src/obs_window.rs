use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

fn fitted_video_size(
    video: PhysicalSize<u32>,
    work_area: PhysicalSize<u32>,
    frame: PhysicalSize<u32>,
) -> Result<PhysicalSize<u32>, String> {
    if video.width == 0 || video.height == 0 {
        return Err("视频尺寸必须大于0".into());
    }
    let max_height = (work_area.height as f64 * 0.8).floor() as u32;
    let available_height = max_height.saturating_sub(frame.height);
    let available_width = work_area.width.saturating_sub(frame.width);
    if available_height == 0 || available_width == 0 {
        return Err("桌面可用区域不足以显示视频窗口".into());
    }
    let scale = (available_height as f64 / video.height as f64)
        .min(available_width as f64 / video.width as f64);
    Ok(PhysicalSize::new(
        (video.width as f64 * scale).floor().max(1.0) as u32,
        (video.height as f64 * scale).floor().max(1.0) as u32,
    ))
}

pub fn resize_to_video(
    window: &WebviewWindow,
    video_width: u32,
    video_height: u32,
) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("无法获取桌面可用区域")?;
    // Work area, video and window decorations are measured in physical pixels,
    // so display scaling cannot make the window exceed the height limit.
    let work_area = monitor.work_area();
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let frame = PhysicalSize::new(
        outer.width.saturating_sub(inner.width),
        outer.height.saturating_sub(inner.height),
    );
    let size = fitted_video_size(
        PhysicalSize::new(video_width, video_height),
        work_area.size,
        frame,
    )?;
    if size != inner {
        window.set_size(size).map_err(|e| e.to_string())?;
    }
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let max_x = work_area.position.x
        + work_area
            .size
            .width
            .saturating_sub(size.width + frame.width) as i32;
    let max_y = work_area.position.y
        + work_area
            .size
            .height
            .saturating_sub(size.height + frame.height) as i32;
    let fitted_position = PhysicalPosition::new(
        position.x.clamp(work_area.position.x, max_x),
        position.y.clamp(work_area.position.y, max_y),
    );
    if fitted_position != position {
        window
            .set_position(fitted_position)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn fit_obs_video(
    window: WebviewWindow,
    video_width: u32,
    video_height: u32,
) -> Result<(), String> {
    if window.label() != "obs" {
        return Err("只能调整 OBS 播放窗口".into());
    }
    resize_to_video(&window, video_width, video_height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portrait_landscape_and_square_fit_the_actual_video_without_side_space() {
        let work = PhysicalSize::new(1920, 1040);
        let frame = PhysicalSize::new(16, 39);
        for video in [
            PhysicalSize::new(1080, 1920),
            PhysicalSize::new(872, 1192),
            PhysicalSize::new(1920, 1080),
            PhysicalSize::new(1000, 1000),
            PhysicalSize::new(3840, 720),
        ] {
            let size = fitted_video_size(video, work, frame).unwrap();
            assert!(size.height + frame.height <= 832);
            assert!(size.width + frame.width <= work.width);
            let scale = size.height as f64 / video.height as f64;
            assert!((size.width as f64 - video.width as f64 * scale).abs() < 6.0);
            assert!(size.height + frame.height == 832 || size.width + frame.width == work.width);
        }
    }

    #[test]
    fn high_dpi_and_small_desktops_include_the_title_bar_in_the_limit() {
        for (work, frame) in [
            (PhysicalSize::new(3840, 2080), PhysicalSize::new(32, 78)),
            (PhysicalSize::new(800, 560), PhysicalSize::new(16, 39)),
        ] {
            let size = fitted_video_size(PhysicalSize::new(1080, 1920), work, frame).unwrap();
            assert!(size.height + frame.height <= (work.height as f64 * 0.8).floor() as u32);
            assert!(size.width + frame.width <= work.width);
        }
        assert!(fitted_video_size(
            PhysicalSize::new(0, 1920),
            PhysicalSize::new(1920, 1080),
            PhysicalSize::new(16, 39)
        )
        .is_err());
        assert!(fitted_video_size(
            PhysicalSize::new(1080, 1920),
            PhysicalSize::new(1, 1),
            PhysicalSize::new(16, 39)
        )
        .is_err());
    }
}
