#!/usr/bin/env python3
"""Read or set the release notes of a version on AMO.

`npm run sign` submits a version without notes, because notes are per-version
and a value kept in `tools/amo-metadata.json` would go stale and be committed by
accident. This sets them afterward through the AMO API, so a release does not
have to finish in the Developer Hub. It works while the version is still waiting
for review; the notes go public when the version does.

    python3 tools/amo-release-notes.py                 # show the current notes
    python3 tools/amo-release-notes.py "What changed."  # set them (en-US)
    python3 tools/amo-release-notes.py --version 1.0.6 "..."

The version defaults to the one in manifest.json. Credentials are the same
WEB_EXT_API_KEY and WEB_EXT_API_SECRET that `npm run sign` uses. Standard
library only, like everything else in this repository.
"""

import argparse, base64, hashlib, hmac, json, os, pathlib, sys, time, uuid
import urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ADDON = 'fastmail-notifier'
API = 'https://addons.mozilla.org/api/v5/addons/addon/{}/versions/v{}/'


def b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def token(key, secret):
    """A JWT as AMO wants it: HS256, and expiring within five minutes."""
    now = int(time.time())
    head = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    body = b64(json.dumps({'iss': key, 'jti': str(uuid.uuid4()),
                           'iat': now, 'exp': now + 60}).encode())
    sig = hmac.new(secret.encode(), (head + '.' + body).encode(), hashlib.sha256).digest()
    return head + '.' + body + '.' + b64(sig)


def call(method, url, auth, data=None):
    req = urllib.request.Request(
        url, method=method,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Authorization': 'JWT ' + auth, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit('AMO answered {}: {}'.format(e.code, e.read().decode()))


def main():
    p = argparse.ArgumentParser(description='Read or set release notes on AMO.')
    p.add_argument('notes', nargs='?', help='new en-US notes; omit to show the current ones')
    p.add_argument('--version', help='version number (default: manifest.json)')
    args = p.parse_args()

    key, secret = os.environ.get('WEB_EXT_API_KEY'), os.environ.get('WEB_EXT_API_SECRET')
    if not key or not secret:
        sys.exit('WEB_EXT_API_KEY and WEB_EXT_API_SECRET must be set.')

    version = args.version or json.loads((ROOT / 'manifest.json').read_text())['version']
    # The `v` prefix makes AMO look the version up by number rather than by id.
    url = API.format(ADDON, version)
    auth = token(key, secret)

    if args.notes is None:
        out = call('GET', url, auth)
    else:
        out = call('PATCH', url, auth, {'release_notes': {'en-US': args.notes}})

    status = (out.get('file') or {}).get('status')
    print('{} ({}, {})'.format(out['version'], out['channel'], status))
    print(json.dumps(out.get('release_notes'), indent=1, ensure_ascii=False))


if __name__ == '__main__':
    main()
