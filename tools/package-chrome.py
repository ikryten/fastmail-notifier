#!/usr/bin/env python3
"""Build the Chrome Web Store zip.

The repository ships one manifest that serves both browsers, which is right for
development and for Firefox. Two of its keys are meaningless to Chrome, and
shipping them to the Web Store is worse than untidy:

  * `background.scripts` -- Firefox MV3 has event pages, not service workers.
    Chrome ignores the key but warns "'background.scripts' requires manifest
    version of 2 or lower" on every load.

  * `browser_specific_settings` -- the Gecko id, minimum version and data
    collection declaration. Firefox-only metadata.

`contextMenus` used to be stripped alongside them, back when the only menu item
was Options and worker.js built it on Gecko alone -- Chrome puts Options on the
action button itself, so the Chrome build genuinely never exercised the
permission. "Check now" changed that: Chrome offers no equivalent, so the Chrome
build now builds a menu too and the permission has to ship with it.

So this strips those two for the Chrome artifact and leaves the source alone.
Nothing else is transformed: no bundling, no minification, no code generation.
"""

import json, pathlib, zipfile, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'web-ext-artifacts'

INCLUDE = ['manifest.json', 'worker.js', 'LICENSE']
INCLUDE_DIRS = ['core', 'data']


def chrome_manifest():
    m = json.loads((ROOT / 'manifest.json').read_text())
    m['background'] = {'service_worker': m['background']['service_worker']}
    m.pop('browser_specific_settings', None)
    return m


def main():
    m = chrome_manifest()
    OUT.mkdir(exist_ok=True)
    target = OUT / f"fastmail_notifier-{m['version']}-chrome.zip"

    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(m, indent=2) + '\n')
        for name in INCLUDE:
            if name != 'manifest.json':
                z.write(ROOT / name, name)
        for d in INCLUDE_DIRS:
            for f in sorted((ROOT / d).rglob('*')):
                if f.is_file():
                    z.write(f, f.relative_to(ROOT).as_posix())

    print(f'wrote {target.relative_to(ROOT)}')
    print(f'  permissions: {m["permissions"]}')
    print(f'  background:  {m["background"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
