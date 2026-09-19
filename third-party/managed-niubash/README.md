# Managed niubash redistribution inputs

PiWeb's release script downloads the unmodified portable archives from the official [niubash v1.1.4 release](https://github.com/unixwin/niubash/releases/tag/v1.1.4), verifies their pinned SHA-256 digests, and copies the complete extracted directories into OS/CPU-restricted npm packages.

The license texts in this directory are pinned copies from:

- niubash v1.1.4 (`unixwin/niubash`)
- rubash revision `8b81c7501646` (`unixwin/rubash`), the revision reported by `niu.exe --version`
- WinuxCmd v1.0.8 (`unixwin/WinuxCmd`), the version reported by `niu.exe --version`

Their source URLs and SHA-256 digests are defined in `scripts/managed-niubash-assets.mjs`. The generated platform-package `licenses/` directories are release artifacts and are not committed.
