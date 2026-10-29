import { useEffect, useState } from 'react';
import { captionAnchorStyle, captionTextStyle, defaultCaptionSettings, type CaptionSettings } from '../captionSettings';

const FADE_OUT_MS = 180;

export function ObsCaption({ content, previous, following, settings = defaultCaptionSettings }: { content: string; previous?: string; following?: string[]; settings?: CaptionSettings }) {
  const next = { content, previous, following: following?.slice(0, 1) };
  const [displayed, setDisplayed] = useState(next);
  const nextKey = JSON.stringify(next), displayedKey = JSON.stringify(displayed);
  // Song timing already accounts for the RTC return path. Keeping the previous
  // line for an exit animation adds a second, inconsistent delay at each cue.
  const songTransition = following !== undefined || displayed.following !== undefined;
  const visible = songTransition ? next : displayed;
  const visibleKey = JSON.stringify(visible);

  useEffect(() => {
    if (nextKey === displayedKey) return;
    if (songTransition || !displayed.content || settings.entrance === 'none') {
      setDisplayed(next);
      return;
    }
    // Keep the outgoing text mounted until it has faded; newer updates cancel
    // this timer so an obsolete caption cannot reappear after a quick change.
    const timer = setTimeout(() => setDisplayed(next), FADE_OUT_MS);
    return () => clearTimeout(timer);
  }, [nextKey, displayedKey, settings.entrance, songTransition]);

  if (!visible.content) return null;
  const exiting = !songTransition && nextKey !== displayedKey;
  return <div className="obs-caption-anchor" style={captionAnchorStyle(settings)}>
    <div key={visibleKey} className={`obs-caption${visible.following ? ' obs-song-caption' : ''}`} data-entrance={visible.following ? 'none' : settings.entrance} data-exiting={exiting || undefined} style={{ ...captionTextStyle(settings), ...(exiting ? { animationDuration: `${FADE_OUT_MS}ms` } : {}) }} role="status" aria-live="polite" aria-hidden={exiting || undefined}>
      {visible.following ? <>
        <div className="obs-song-previous" aria-hidden={!visible.previous || undefined}>{visible.previous || '\u00a0'}</div>
        <div className="obs-song-current" aria-current="true">{visible.content}</div>
        <div className="obs-song-following" aria-hidden={!visible.following[0] || undefined}>{visible.following[0] || '\u00a0'}</div>
      </> : visible.content}
    </div>
  </div>;
}
