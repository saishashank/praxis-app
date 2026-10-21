"use client";
// The what-if form and its answer (UX-119). The choices are the ones the nightly batch has stored
// rows for; the server checks them again and answers only from those rows. Money is simulated and
// labelled as such (AT-27).
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Money, SimulatedLabel } from "@/components/ui/Values";
import type { WhatIfOptions } from "@/lib/whatif/options";
import { whatIfErrorText, type WhatIfActionResult } from "./messages";

type Props = {
  options: WhatIfOptions;
  remaining: number;
  limit: number;
  action: (fd: FormData) => Promise<WhatIfActionResult>;
};

const PROFILE_WORDS: Record<string, string> = { stress: "Stress (wider slippage, profile P3)" };
const profileText = (p: string): string => PROFILE_WORDS[p] ?? `Cost profile ${p}`;

const FIELD = "rounded-md border border-border bg-bg px-2 py-2 text-text";

export function WhatIfForm({ options, remaining, limit, action }: Props) {
  const [kind, setKind] = useState("cost");
  const [result, run, pending] = useActionState<WhatIfActionResult | null, FormData>(
    async (_prev, fd) => action(fd),
    null,
  );
  const left = result !== null && "ok" in result ? result.budget.remaining : remaining;
  const out = result !== null && "ok" in result ? result.view : null;
  return (
    <div className="flex flex-col gap-4">
      <form action={run} className="flex min-w-0 flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>What do you want to ask?</span>
          <select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className={FIELD}
          >
            <option value="cost">What if it paid different trading costs?</option>
            <option value="shock">What if every share moved by the same percentage?</option>
            <option value="custom">Something else (any other change)</option>
          </select>
        </label>
        {kind === "custom" ? (
          <input type="hidden" name="key" value="custom" />
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            <span>Strategy</span>
            <select name="key" required className={FIELD}>
              {options.strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.id})
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === "cost" ? (
          <label className="flex flex-col gap-1 text-sm">
            <span>Trading costs</span>
            <select name="profile" className={FIELD}>
              {options.profiles.map((p) => (
                <option key={p} value={p}>
                  {profileText(p)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {kind === "shock" ? (
          <label className="flex flex-col gap-1 text-sm">
            <span>Price move</span>
            <select name="pct" className={FIELD}>
              {options.shocks.map((p) => (
                <option key={p} value={String(p)}>
                  {p > 0 ? `+${p}%` : `${p}%`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending || left <= 0}>
            Run what-if
          </Button>
          <span role="status" className="text-sm text-text-muted">
            {left} of {limit} left today.
            {left <= 0 ? " The count starts again at midnight in Melbourne." : ""}
          </span>
        </div>
      </form>
      {result !== null && "error" in result ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {whatIfErrorText(result.error)}
        </p>
      ) : null}
      {out ? (
        <Card title={`${out.name} (${out.execution})`} headingLevel={2} aria-live="polite">
          <p className="mt-0 text-sm text-text-muted">
            From the nightly result of {out.d}. <SimulatedLabel />
          </p>
          {out.result.kind === "cost" ? (
            <dl className="m-0 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-text-muted">
                  Value if sold today, {profileText(out.result.profile)}
                </dt>
                <dd className="m-0">
                  <Money micro={out.result.liqNavMicro} />
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">
                  Value if sold today, its own costs ({out.result.ownProfile})
                </dt>
                <dd className="m-0">
                  <Money micro={out.result.ownLiqNavMicro} />
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">Difference</dt>
                <dd className="m-0">
                  <Money micro={out.result.diffMicro} sign="always" />
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">Brokerage so far (this / its own)</dt>
                <dd className="m-0">
                  <Money micro={out.result.feesMicro} /> / <Money micro={out.result.ownFeesMicro} />
                </dd>
              </div>
            </dl>
          ) : (
            <dl className="m-0 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-text-muted">
                  Change in value if every share moved {out.result.pct > 0 ? "+" : ""}
                  {out.result.pct}%
                </dt>
                <dd className="m-0">
                  <Money micro={out.result.pnlMicro} sign="always" />
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">Shares held now</dt>
                <dd className="m-0">
                  <Money micro={out.result.valueMicro} />
                </dd>
              </div>
              <div>
                <dt className="text-text-muted">Total value after the move</dt>
                <dd className="m-0">
                  <Money micro={out.result.navAfterMicro} />
                </dd>
              </div>
            </dl>
          )}
        </Card>
      ) : null}
    </div>
  );
}
