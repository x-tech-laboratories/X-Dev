// The GitHub webhook calls described for other programs: what each does and the arguments it takes. Only an admin
// reaches them.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";

import { text } from "../api_schemas.ts";
import type { WebhookMethods } from "./model.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

export const webhooks_api: ApiSpec<WebhookMethods> = {
  get_github_webhook: {
    description:
      "How GitHub's webhooks reach this X-Dev, which then syncs the items a pull request, check or issue event names at once instead of waiting for its next poll: the payload URL, content type and events to enter on GitHub, whether a secret is set (never the secret itself), whether this host can add the hook itself, and the latest delivery from each repository.",
    params: [],
  },
  set_github_webhook_url: {
    description: "Sets the public address GitHub reaches this X-Dev at, such as https://dev.example.org, from which the payload URL is made; empty to clear it.",
    params: [{ name: "public_url", schema: text("The address, http or https with a host and an optional path.") }],
  },
  create_github_webhook_secret: {
    description:
      "Makes a new random secret that GitHub signs every delivery with, replacing the one before, so a hook set up with the old one is refused until it is given the new one. The secret is not given back; show_github_webhook_setup shows it.",
    params: [],
  },
  show_github_webhook_setup: {
    description: "Shows everything GitHub's Add webhook form asks for, the secret included, for an admin to copy into it. Treat the answer as a password.",
    params: [],
  },
  register_github_webhook: {
    description:
      "Adds the webhook to a GitHub repository through the gh program this computer is signed into, or updates the hook already sending to this payload URL, with the events and the secret. Needs the public address and a secret first, and works only on the computer that runs the agents.",
    params: [{ name: "repository", schema: text("The repository as owner/name.") }],
  },
};
