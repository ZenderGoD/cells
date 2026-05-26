# Cells Runtime Extension Inputs

The extension lab loads unpacked extensions only. It deliberately avoids Chrome Web
Store install flow and CRX unpacking so the first pass tests extension primitives.

Bundled probe extensions are copied into `dist-cells/test-extensions` during the
main Cells build.

To add real unpacked extensions for manual testing:

```sh
CELLS_NW_EXTENSIONS=/absolute/path/to/extension-a,/absolute/path/to/extension-b pnpm dev
```

Keep remote webviews untrusted. Do not add `allownw` to webviews that load remote
HTTP or HTTPS pages.
