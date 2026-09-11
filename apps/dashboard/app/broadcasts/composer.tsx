'use client';

import { useState, useTransition } from 'react';
import { composeBroadcast } from './actions';

/**
 * The composer never sends. It asks the agent for a translation preview, which
 * is posted to Slack with a Send button — so the thing that goes out is the
 * thing a person read.
 */
export function BroadcastComposer({ sites }: { sites: Array<{ id: string; name: string }> }) {
  const [text, setText] = useState('');
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="card flex flex-col gap-[16px] p-[24px]"
      action={(formData) => {
        startTransition(async () => {
          const result = await composeBroadcast(formData);
          setMessage(result.message);
          if (result.ok) setText('');
        });
      }}
    >
      <label className="flex flex-col gap-[8px]">
        <span className="label">Message, in English</span>
        <textarea
          name="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          maxLength={600}
          required
          placeholder="The bus to Site B leaves at 4:30 today."
          className="rounded-[2px] border border-[--color-rule] bg-[--color-paper] p-[8px] text-[14px]"
        />
      </label>

      <fieldset className="flex flex-col gap-[8px]">
        <legend className="label">Sites</legend>
        <div className="flex flex-wrap gap-[16px]">
          {sites.map((site) => (
            <label key={site.id} className="flex items-center gap-[8px] text-[13px]">
              <input
                type="checkbox"
                name="siteIds"
                value={site.id}
                checked={siteIds.includes(site.id)}
                onChange={(event) =>
                  setSiteIds((current) =>
                    event.target.checked ? [...current, site.id] : current.filter((id) => id !== site.id),
                  )
                }
              />
              {site.name}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center gap-[16px]">
        <button
          type="submit"
          disabled={pending || text.trim().length === 0 || siteIds.length === 0}
          className="rounded-[2px] border border-[--color-ink] bg-[--color-ink] px-[16px] py-[6px] text-[13px] text-[--color-card] disabled:opacity-40"
        >
          {pending ? 'Translating…' : 'Preview translations'}
        </button>
        <span className="text-[12px] text-[--color-ink-3]">
          Nothing is sent until you press Send on the preview.
        </span>
      </div>

      {message ? <p className="text-[13px]">{message}</p> : null}
    </form>
  );
}
