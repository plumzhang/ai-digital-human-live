import { useEffect, useState } from 'react';
import { captionAnchorStyle, captionTextStyle, defaultCaptionSettings, type CaptionSettings } from '../captionSettings';

const FADE_OUT_MS = 180;

export function ObsCaption({ content, settings = defaultCaptionSettings }: { content: string; settings?: CaptionSettings }) {
  const [displayed, setDisplayed] = useState(content);

  useEffect(() => {
    if (content === displayed) return;
    if (!displayed || settings.entrance === 'none') {
      setDisplayed(content);
      return;
    }
    // Keep the outgoing text mounted until it has faded; newer updates cancel
    // this timer so an obsolete caption cannot reappear after a quick change.
    const timer = setTimeout(() => setDisplayed(content), FADE_OUT_MS);
    return () => clearTimeout(timer);
  }, [content, displayed, settings.entrance]);

  if (!displayed) return null;
  const exiting = content !== displayed;
  return <div className="obs-caption-anchor" style={captionAnchorStyle(settings)}>
    <div key={displayed} className="obs-caption" data-entrance={settings.entrance} data-exiting={exiting || undefined} style={{ ...captionTextStyle(settings), ...(exiting ? { animationDuration: `${FADE_OUT_MS}ms` } : {}) }} role="status" aria-live="polite" aria-hidden={exiting || undefined}>{displayed}</div>
  </div>;
}
