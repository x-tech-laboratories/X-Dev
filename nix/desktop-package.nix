{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  electron_43,
  makeWrapper,
  copyDesktopItems,
  makeDesktopItem,
}:

buildNpmPackage {
  pname = "x-dev-desktop";
  version = (lib.importJSON ../package.json).version;
  src = lib.cleanSource ../.;

  nodejs = nodejs_24;
  # Read from package-lock.json, so there is no deps hash to keep in step with it.
  npmDeps = importNpmLock { npmRoot = ../.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [
    makeWrapper
    copyDesktopItems
  ];

  npmBuildScript = "build:desktop";

  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save --ignore-scripts
    mkdir -p $out/lib/x-dev-desktop
    cp -r out package.json node_modules resources $out/lib/x-dev-desktop/
    install -Dm644 resources/icon.png $out/share/icons/hicolor/512x512/apps/x-dev.png
    makeWrapper ${lib.getExe electron_43} $out/bin/x-dev-desktop \
      --add-flags $out/lib/x-dev-desktop \
      --unset ELECTRON_RUN_AS_NODE \
      --set X_DEV_LAUNCHER x-dev-desktop

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "x-dev";
      desktopName = "X-Dev";
      comment = "Features and bug fixes taken through stages";
      exec = "x-dev-desktop %U";
      icon = "x-dev";
      categories = [ "Utility" ];
      # Opens x-dev://<page> links, such as a reminder's, in the app.
      mimeTypes = [ "x-scheme-handler/x-dev" ];
    })
  ];

  meta = {
    description = "X-Dev as a desktop app with its own database";
    license = lib.licenses.gpl3Plus;
    mainProgram = "x-dev-desktop";
  };
}
