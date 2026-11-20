// The item's pull request on its page: its link and state, each check with how it went, and how the issue is kept in
// step with GitHub, with what failed last and a button that tries again.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";
import { StateBadge, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Facts, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";

import type { CheckBucket, PullRequest, PullRequestState } from "../../shared/items/github.ts";
import type { Item } from "../../shared/items/model.ts";
import { attempt, data_watch, page, use_data } from "../api.ts";

// ── Words ────────────────────────────────────────────────────────────────────

const pull_request_labels: Record<PullRequestState | "draft", [string, Tone]> = {
  open: ["Open", "info"],
  draft: ["Draft", "none"],
  merged: ["Merged", "good"],
  closed: ["Closed", "bad"],
};

const check_labels: Record<CheckBucket, [string, Tone]> = {
  pass: ["Passed", "good"],
  fail: ["Failed", "bad"],
  pending: ["Running", "info"],
  skipping: ["Skipped", "none"],
  cancel: ["Cancelled", "warn"],
};

// ── Panel ────────────────────────────────────────────────────────────────────

function Checks({ pull_request }: { pull_request: PullRequest }) {
  if (!pull_request.checks.length) return <p className="muted">No checks reported yet.</p>;
  return (
    <Facts
      layout="rows"
      rows={pull_request.checks.map((check): [string, ReactNode] => [
        check.workflow ? `${check.workflow} / ${check.name}` : check.name,
        <>
          <StateBadge labels={check_labels} state={check.bucket} />
          {check.link && (
            <>
              {" "}
              <a href={check.link} target="_blank" rel="noreferrer" aria-label={`Details of ${check.name}`}>
                Details
              </a>
            </>
          )}
        </>,
      ])}
    />
  );
}

export function PullRequestPanel({ item }: { item: Item }) {
  const { runner } = page();
  const github = use_data((api) => api.get_item_github(item.id), [item.id, item.pull_request, item.github]);
  const pull_request = github.data?.pull_request ?? null;
  const mirror = github.data?.mirror;
  if (item.issue_number === null && !pull_request) return null;

  async function sync(): Promise<void> {
    const problem = await attempt(() => runner!.sync_github(item.id));
    if (problem === undefined) return;
    toast(problem ? `GitHub: ${problem}` : "In step with GitHub.", { tone: problem ? "bad" : "good" });
    data_watch.bump();
  }

  return (
    <Section
      title="Pull Request"
      tools={
        runner && (
          <button type="button" onClick={() => void sync()}>
            Sync to GitHub
          </button>
        )
      }
    >
      {pull_request ? (
        <>
          <Facts
            rows={[
              [
                "Pull request",
                <a key="link" href={pull_request.url} target="_blank" rel="noreferrer">
                  #{pull_request.number}
                </a>,
              ],
              ["State", <StateBadge key="state" labels={pull_request_labels} state={pull_request.draft && pull_request.state === "open" ? "draft" : pull_request.state} />],
              pull_request.changed_at ? ["Changed", <Age key="changed" epoch={Date.parse(pull_request.changed_at) / 1000} />] : null,
            ]}
          />
          <Checks pull_request={pull_request} />
        </>
      ) : (
        <p className="muted">No pull request yet; Review opens one from the item's branch.</p>
      )}
      {mirror?.problem && (
        <p className="danger" role="alert">
          GitHub could not be kept in step: {mirror.problem}
        </p>
      )}
      {mirror?.synced_at && (
        <p className="muted small">
          Issue last updated <Age epoch={Date.parse(mirror.synced_at) / 1000} />
        </p>
      )}
    </Section>
  );
}
