self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.x-dev;
  inherit (lib)
    literalExpression
    mkEnableOption
    mkIf
    mkOption
    types
    ;

  state_directory = "/var/lib/x-dev";

  config_file = (pkgs.formats.json { }).generate "x-dev.json" (
    {
      database = "${state_directory}/dev.db";
      backups_folder = "${state_directory}/backups";
      stages_folder = "${state_directory}/stages";
    }
    // lib.optionalAttrs (cfg.syncAddress != null) { sync_address = cfg.syncAddress; }
  );
in
{
  options.services.x-dev = {
    enable = mkEnableOption "X-Dev, a web app that takes features and bug fixes through stages and that its devices sync with";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = literalExpression "x-dev (from flake)";
      description = "The X-Dev package to use.";
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "Address the page, API and sync listen on.";
    };

    port = mkOption {
      type = types.port;
      default = 7760;
      description = "Port the page, API and sync listen on.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the port in the firewall.";
    };

    syncAddress = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "https://dev.example.org/api/";
      description = "Where paired devices reach this server's sync, through its reverse proxy; without it the server only reaches out to devices that let others connect.";
    };

    passwordHashFile = mkOption {
      type = types.str;
      example = "/etc/x-dev/password-hash";
      description = ''
        The accounts file: one `name:hash` line per admin, from `npm run hash-password`. Admins add other users on the
        Users page.
      '';
    };
  };

  config = mkIf cfg.enable {
    systemd.services.x-dev = {
      description = "X-Dev";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      environment = {
        X_DEV_CONFIG = toString config_file;
        X_DEV_HOST = cfg.host;
        X_DEV_PORT = toString cfg.port;
        X_DEV_PASSWORD_HASH_FILE = "%d/password-hash";
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        DynamicUser = true;
        StateDirectory = "x-dev";
        StateDirectoryMode = "0700";
        LoadCredential = [ "password-hash:${cfg.passwordHashFile}" ];
        Restart = "always";
        RestartSec = "5s";

        CapabilityBoundingSet = "";
        LockPersonality = true;
        NoNewPrivileges = true;
        PrivateDevices = true;
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" ];
        UMask = "0077";
      };
    };

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.port ];
  };
}
