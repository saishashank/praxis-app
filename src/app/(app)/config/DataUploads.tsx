"use client";
// "Data files" card (DAT-234, DAT-236, FAM-006): the Owner's CSV uploads. Three small forms, each
// with a file, a confirmation box and the shape of the file in plain words. The server actions
// re-check the role and the confirmation. Shown to the Owner only (the page requires "admin").
import { useActionState } from "react";
import { buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { errorText } from "@/lib/users/messages";

type Result = { ok: true; message: string } | { error: string; message?: string };
type Action = (fd: FormData) => Promise<Result>;

type Props = {
  uploadIndexChanges: Action;
  uploadIndustryMap: Action;
  uploadUniverse: Action;
};

function UploadForm({
  id,
  title,
  shape,
  action,
}: {
  id: string;
  title: string;
  shape: string;
  action: Action;
}) {
  const [state, run] = useActionState<Result | null, FormData>((_prev, fd) => action(fd), null);
  return (
    <form
      action={run}
      data-upload={id}
      className="flex min-w-0 flex-col gap-2 border-t border-border py-3 first:border-t-0"
    >
      <h3 className="m-0 text-sm font-semibold">{title}</h3>
      <p className="m-0 text-sm text-text-muted">{shape}</p>
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        <span>CSV file</span>
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          className="min-h-6 min-w-0 rounded-md border border-border bg-bg p-2 text-text"
        />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirm" value="upload_reference_file" required />
        <span>I have checked this file and want it loaded.</span>
      </label>
      <div>
        <button type="submit" className={buttonClass("secondary")}>
          Upload
        </button>
      </div>
      {state !== null && "error" in state && (
        <p role="alert" className="m-0 text-sm text-danger">
          {state.message ?? errorText(state.error)}
        </p>
      )}
      {state !== null && "ok" in state && (
        <p role="status" className="m-0 text-sm">
          {state.message}
        </p>
      )}
    </form>
  );
}

export function DataUploads({ uploadIndexChanges, uploadIndustryMap, uploadUniverse }: Props) {
  return (
    <Card aria-label="Data files" title="Data files" data-data-files="">
      <p className="m-0 mb-2 text-sm text-text-muted">
        Files you keep by hand. They are data, not settings, and are never overwritten: a row that
        is already loaded stays as it is.
      </p>
      <UploadForm
        id="index_changes"
        title="Index changes"
        shape="Columns: code, index, change (add or delete), announced (may be empty), effective, source. Dates as YYYY-MM-DD. A news event close to an index change is left out of the event-driven strategy."
        action={uploadIndexChanges}
      />
      <UploadForm
        id="industry_map"
        title="Industry classes"
        shape="Columns: code, industry, as_of (the first date the class applies, YYYY-MM-DD). Used to keep two overnight picks out of the same industry."
        action={uploadIndustryMap}
      />
      <UploadForm
        id="universe"
        title="Listed companies (fallback)"
        shape="The ASX listed-companies file: Company name, ASX code, GICS industry group. Use it only if the automatic download is not working. It goes through the same checks, including the refusal of a file that is far smaller than the last one."
        action={uploadUniverse}
      />
    </Card>
  );
}
