# Linux Packaging

Cells publishes Linux release artifacts for `x64` and `arm64`:

- `Cells-<version>-linux-<arch>.AppImage`
- `Cells-<version>-linux-<arch>.deb`
- `Cells-<version>-linux-<arch>.tar.gz`
- `Cells-<version>-linux-x86_64.rpm`

The `.deb` is the recommended artifact for Ubuntu and Debian-based systems. The tarball is the recommended upstream source for distro package repositories such as Nixpkgs and Gentoo overlays because it is stable, explicit, and does not run package-manager maintainer scripts from another distro.

## Build Locally

On Linux:

```bash
pnpm install --frozen-lockfile
pnpm release:linux
```

`pnpm release:linux` builds the app, bundles Linux `zellij` and `tmux` binaries for `x64` and `arm64`, and emits AppImage, deb, tarball, and x64 rpm artifacts in `release/`.

To build only the host architecture while developing packaging changes:

```bash
pnpm prepare:mcp-server
pnpm prepare:terminal-bundles
pnpm typecheck
pnpm build:vite
pnpm exec electron-builder --linux --publish never
```

## Ubuntu

Users can install the release `.deb` directly:

```bash
sudo apt install ./Cells-<version>-linux-x64.deb
```

For an apt repository or PPA, publish the upstream `.deb` or rebuild it from a source package. A minimal source-package flow is:

```bash
mkdir -p cells_<version>
tar --strip-components=1 -xf cells-<version>.tar.gz -C cells_<version>
cd cells_<version>
pnpm install --frozen-lockfile
pnpm release:linux
```

The generated deb declares the Electron runtime libraries Cells needs:

- `libgtk-3-0`
- `libnotify4`
- `libnss3`
- `libxss1`
- `libxtst6`
- `xdg-utils`
- `libatspi2.0-0`
- `libuuid1`
- `libsecret-1-0`

## Nix and NixOS

Use the Linux tarball as the packaged binary input. This derivation is suitable for a Nixpkgs package or an overlay:

```nix
{ appimageTools
, fetchurl
, lib
}:

let
  version = "<version>";
  src = fetchurl {
    url = "https://github.com/xrehpicx/cells/releases/download/v${version}/Cells-${version}-linux-x64.AppImage";
    hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  };
  appimageContents = appimageTools.extractType2 { inherit src; pname = "cells"; inherit version; };
in
appimageTools.wrapType2 {
  pname = "cells";
  inherit version src;

  extraInstallCommands = ''
    install -Dm444 ${appimageContents}/cells.desktop $out/share/applications/cells.desktop
    install -Dm444 ${appimageContents}/cells.png $out/share/pixmaps/cells.png
    substituteInPlace $out/share/applications/cells.desktop \
      --replace-fail 'Exec=AppRun' 'Exec=cells'
  '';

  meta = {
    description = "Infinite desktop workspace for terminals, browsers, and agent workflows";
    homepage = "https://github.com/xrehpicx/cells";
    license = lib.licenses.asl20;
    platforms = [ "x86_64-linux" "aarch64-linux" ];
    mainProgram = "cells";
  };
}
```

For `aarch64-linux`, change the artifact name to `Cells-${version}-linux-arm64.AppImage` and update the hash.

## Gentoo

Use the Linux tarball in an overlay ebuild. This skeleton installs the prebuilt app under `/opt/cells` and exposes `/usr/bin/cells`:

```bash
EAPI=8

DESCRIPTION="Infinite desktop workspace for terminals, browsers, and agent workflows"
HOMEPAGE="https://github.com/xrehpicx/cells"
SRC_URI="
  amd64? ( https://github.com/xrehpicx/cells/releases/download/v${PV}/Cells-${PV}-linux-x64.tar.gz -> ${P}-amd64.tar.gz )
  arm64? ( https://github.com/xrehpicx/cells/releases/download/v${PV}/Cells-${PV}-linux-arm64.tar.gz -> ${P}-arm64.tar.gz )
"

LICENSE="Apache-2.0"
SLOT="0"
KEYWORDS="~amd64 ~arm64"
IUSE=""

RDEPEND="
  dev-libs/nss
  gnome-base/librsvg
  sys-apps/dbus
  x11-libs/gtk+:3
  x11-libs/libnotify
  x11-libs/libXtst
  x11-misc/xdg-utils
"

S="${WORKDIR}"

src_install() {
  local appdir="/opt/cells"
  insinto "${appdir}"
  doins -r .
  fperms +x "${appdir}/cells"
  dosym "${appdir}/cells" /usr/bin/cells
}
```

After adding the ebuild to an overlay:

```bash
ebuild cells-<version>.ebuild manifest
emerge --ask cells
```

## Maintainer Checklist

1. Replace `<version>` with the release version without the leading `v`.
2. Replace all placeholder hashes with hashes from the downloaded artifacts.
3. Test launch on a clean VM for each target distro.
4. Confirm terminal panes can start; this verifies the bundled `tmux` and `zellij` binaries are reachable.
