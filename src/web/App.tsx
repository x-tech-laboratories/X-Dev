// The page: the sign-in in a browser, the shell around every section, and the router between them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Fragment, useEffect, useState } from "react";
import { create_accounts_client, type Me } from "@x-tech-laboratories/x-libs/web/accounts";
import { AccountView, UsersView } from "@x-tech-laboratories/x-libs/web/react/accounts";
import { SyncCertificatePrompt } from "@x-tech-laboratories/x-libs/web/react/certificates";
import { ConnectionSettings } from "@x-tech-laboratories/x-libs/web/react/connections";
import { PageHeading } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Shell, use_route } from "@x-tech-laboratories/x-libs/web/react/shell";
import { SignInForm, use_account } from "@x-tech-laboratories/x-libs/web/react/sign_in";
import { theme_choice } from "@x-tech-laboratories/x-libs/web/theme";

import { data_watch, page } from "./api.ts";
import { page_features } from "./features.tsx";
import { HistoryView } from "./history/HistoryView.tsx";
import { SettingsView } from "./settings/SettingsView.tsx";
import { Sidebar, SidebarFoot } from "./Sidebar.tsx";

// ── Sections ─────────────────────────────────────────────────────────────────

const theme = theme_choice("x-dev-theme");
const brand_icon = "icon.svg";

// Relative, so a server behind a proxy under a folder keeps it.
const accounts = create_accounts_client({ base: "api" });

// Sections outside the features, the account pages only for someone signed in on the server.
const own_sections = ["settings", "account", "users"];

// ── App ──────────────────────────────────────────────────────────────────────

// A desktop or phone app works on the daemon it connected to, and one that syncs asks to trust its server's certificate.
function DeviceApp() {
  const { certificates, device, connections } = page();
  const [has_daemon, set_has_daemon] = useState<boolean | null>(connections ? null : true);
  useEffect(() => void connections?.list_connections().then((view) => set_has_daemon(view.current !== null), () => set_has_daemon(true)), [connections]);
  if (has_daemon === null) return null;
  if (!has_daemon && connections) return <FirstConnection />;
  return <>
    {device && certificates && <SyncCertificatePrompt device={device} certificates={certificates} subscribe={data_watch.subscribe} />}
    <Pages me={null} />
  </>;
}

// A phone with no daemon yet adds the computer that runs the agents before anything else.
function FirstConnection() {
  const { connections, certificates } = page();
  return (
    <Shell brand="X-Dev" brand_icon={brand_icon} theme={theme} user={null}>
      <PageHeading title="Connect to X-Dev" subtitle="Add the computer that holds your checkouts and runs the agents, with its address and an admin's name and password. Turn on Let other devices connect in its Settings first." />
      <ConnectionSettings client={connections!} certificates={certificates} placeholder="https://dev.example.org:7760" />
    </Shell>
  );
}

export function App() {
  return page().host === "web" ? <SignedInApp /> : <DeviceApp />;
}

function SignedInApp() {
  const { account, refresh, sign_out } = use_account(accounts);
  if (account.state === "checking") return null;
  if (account.state === "signed_out") {
    return (
      <Shell brand="X-Dev" brand_icon={brand_icon} theme={theme} user={null}>
        <SignInForm client={accounts} title="X-Dev" icon={brand_icon} on_signed_in={() => (page().runner ? refresh() : location.reload())} />
      </Shell>
    );
  }
  return <Pages me={account.me} on_sign_out={() => void sign_out()} />;
}

function Pages({ me, on_sign_out }: { me: Me | null; on_sign_out?: () => void }) {
  const route = use_route();
  const [named_section = "board", ...rest] = route.parts;
  const feature = page_features.find((candidate) => candidate.id === named_section);
  const is_own = named_section === "settings" || named_section === "history" || (me !== null && own_sections.includes(named_section));
  const section = feature || is_own ? named_section : "board";
  const page = feature?.pages.find((candidate) => candidate.id === rest[0]) ?? feature?.pages[0];
  const own_labels: Record<string, string> = { settings: "Settings", history: "History", account: "Your account", users: "Users" };
  const label = feature ? (feature.pages.length < 2 ? feature.label : `${page!.label} · ${feature.label}`) : own_labels[section] ?? "Board";
  const view_key = route.parts.join("/");
  const is_admin = me !== null && me.role === me.roles.at(-1);

  useEffect(() => {
    document.title = `${label} · X-Dev`;
  }, [label]);

  const view = () => {
    if (feature) return feature.view(rest);
    if (me && section === "account") return <AccountView client={accounts} />;
    if (me && section === "users") return <UsersView client={accounts} me={me} />;
    if (section === "history") return <HistoryView />;
    return <SettingsView />;
  };

  return (
    <Shell
      brand="X-Dev"
      brand_icon={brand_icon}
      sidebar={<Sidebar features={page_features} section={section} page={page?.id ?? ""} />}
      sidebar_foot={<SidebarFoot section={section} show_users={is_admin} />}
      theme={theme}
      view_key={view_key}
      user={me?.name}
      user_href="#/account"
      on_logout={on_sign_out}
      settings={{ href: "#/settings", active: section === "settings" }}
      contained={feature?.contained ?? false}
    >
      <Fragment key={view_key}>{view()}</Fragment>
    </Shell>
  );
}
