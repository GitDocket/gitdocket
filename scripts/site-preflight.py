#!/usr/bin/env python3
"""Read-only source/live site checks. Optional commands run only in a temporary fixture."""
import argparse
import concurrent.futures
import datetime
import hashlib
import html
import json
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

APEX = 'https://gitdocket.com'
BEACON_URL = 'https://static.cloudflareinsights.com/beacon.min.js/v31edd6df95cf4e85bb4c19e7a9bdbcba1788362987495'
BEACON_INTEGRITY = 'sha512-iIg7k2xntmwu6/uSb5tpc/hySgZc4eoL31yB29W6tJFo2akwjPWcEqnCEdJvGexCL0KEQwVYv5BlowfhVz26hg=='
MIMES = {'.md': {'text/markdown', 'text/plain'}, '.html': {'text/html'}, '.svg': {'image/svg+xml'}, '.png': {'image/png'}, '.jpg': {'image/jpeg'}, '.css': {'text/css'}, '.js': {'text/javascript', 'application/javascript'}, '.json': {'application/json'}, '.gz': {'application/gzip', 'application/x-gzip', 'application/octet-stream'}, '.txt': {'text/plain'}, '.xml': {'application/xml', 'text/xml'}}


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.links, self.ids, self.meta, self.canonical, self.current, self.text = [], set(), {}, [], [], []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if 'id' in a:
            self.ids.add(a['id'])
        self.links.extend(a[k] for k in ('src', 'href') if k in a)
        if tag == 'meta':
            name = a.get('property', a.get('name'))
            self.meta.setdefault(name, []).append(a.get('content', ''))
            if name in ('og:image', 'twitter:image'):
                self.links.append(a.get('content', ''))
        if tag == 'link' and a.get('rel') == 'canonical':
            self.canonical.append(a.get('href'))
        if a.get('aria-current') == 'page':
            self.current.append(a.get('href'))

    def handle_data(self, data):
        self.text.append(data)


def version_errors(text, version):
    text = ' '.join(html.unescape(text).split())
    errors = []
    for match in re.finditer(r'(?:GitDocket\s+|current release (?:is\s+)?|recommended current release\s+)(\d+\.\d+\.\d+)([^.]{0,30})', text):
        found, following = match.groups()
        # An explicitly described minimum is a compatibility promise, not the current release.
        if found != version and not re.match(r'\s*(?:or later|\+)', following):
            errors.append('current release declaration ' + found + ' differs from ' + version)
    for found in re.findall(r'(\d+\.\d+\.\d+)\s+release notes', text):
        if found != version:
            errors.append('current release notes label ' + found + ' differs from ' + version)
    for found in re.findall(r'https://github\.com/GitDocket/gitdocket/releases/tag/v(\d+\.\d+\.\d+)', text):
        if found != version:
            errors.append('current release link v' + found + ' differs from ' + version)
    return errors


def command_status_errors(text):
    statuses = re.findall(r'docket task move\s+\S+\s+(\S+)', text)
    return ['unsupported documented task status ' + status for status in statuses if status not in ('todo', 'in-progress', 'in-review', 'blocked', 'done', 'closed', '<status>')]


def artifact_checks(root, version):
    errors = []
    provenance = json.loads((root / 'site/docs/mcp/provenance.json').read_text())
    raw = (root / 'site/docs/mcp/tools.json').read_bytes()
    tools = json.loads(raw)['tools']
    if digest(raw) != provenance['outputSha256']:
        errors.append('MCP raw capture hash differs from provenance')
    versions = [provenance['executableVersion'], provenance['serverInfo']['version'], provenance['build']['version'], *[p['version'] for p in provenance['packages']]]
    if any(v != version for v in versions):
        errors.append('MCP capture does not describe selected published version')
    source = provenance['build']['source']
    if not re.fullmatch(r'[a-f0-9]{40}', source.get('commit', '')) or any(p['gitdocketSource'] != source for p in provenance['packages']):
        errors.append('MCP package/build source identities disagree')
    names = [t['name'] for t in tools]
    if names != provenance['toolsNames'] or len(tools) != provenance['toolsCount'] or len(names) != len(set(names)):
        errors.append('MCP tool names/count differ from capture provenance')
    reference = (root / 'site/docs/mcp/index.html').read_text()
    if any(name not in reference for name in names):
        errors.append('MCP reference omits a captured tool')
    manifest = json.loads((root / 'site/examples/workflow-examples.json').read_text())
    archive = root / 'site/examples/workflow-examples.tar.gz'
    if digest(archive.read_bytes()) != manifest['sha256']:
        errors.append('example archive hash differs from manifest')
    members = {}
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            name = member.name
            while name.startswith('./'):
                name = name[2:]
            if member.isdir():
                continue
            if not member.isfile() or pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts or name in members:
                errors.append('unsafe/duplicate example archive entry: ' + name)
                continue
            members[name] = tar.extractfile(member).read()
    expected = set(manifest['files']) | {'example-contents.json'}
    if set(members) != expected:
        errors.append('example archive contains missing/unmanifested files')
    inner = json.loads(members.get('example-contents.json', b'{}'))
    if inner.get('files') != manifest['files']:
        errors.append('inner and download archive manifests disagree')
    for path, sha in manifest['files'].items():
        if path not in members or digest(members[path]) != sha:
            errors.append('example archive file hash differs: ' + path)
        if path not in ('README.md', 'package.json'):
            file = root / path
            if not file.is_file() or digest(file.read_bytes()) != sha:
                errors.append('stale generated example source: ' + path)
    errors.extend(version_errors(members.get('README.md', b'').decode(), version))
    return errors, {'mcpTools': len(tools), 'mcpSha256': digest(raw), 'mcpSource': source, 'archiveSha256': digest(archive.read_bytes()), 'archiveFiles': len(manifest['files'])}


def source_checks(root, version):
    site = root / 'site'
    manifest = set(json.loads((root / 'release/public-export.json').read_text())['paths'])
    pages = {p: Page(p.read_text()) for p in site.rglob('*.html')}
    errors, routes, canonicals, references = [], {}, [], 0
    for path, page in pages.items():
        rel = path.relative_to(site).as_posix()
        route = '/' if rel == 'index.html' else '/' + rel.removesuffix('index.html')
        canonical = APEX + route
        routes[route] = (path, 200)
        if rel != '404.html':
            canonicals.append(canonical)
            if page.canonical != [canonical] or page.meta.get('og:url') != [canonical]:
                errors.append(rel + ': canonical/OG URL mismatch')
        elif page.meta.get('robots') != ['noindex']:
            errors.append('404 page must opt out of indexing')
        if rel.startswith('docs/') and (not page.current or any(x != route for x in page.current)):
            errors.append(rel + ': current-page navigation mismatch')
        errors.extend(rel + ': ' + e for e in command_status_errors(' '.join(page.text)))
        errors.extend(rel + ': ' + e for e in set(version_errors(' '.join(page.text), version) + version_errors(path.read_text(), version)))
        if not page.meta.get('og:title') or not page.meta.get('og:description'):
            errors.append(rel + ': missing page sharing text')
        image = page.meta.get('og:image', [])
        if len(image) != 1 or not image[0].startswith(APEX + '/') or page.meta.get('og:image:width') != ['1200'] or page.meta.get('og:image:height') != ['630'] or page.meta.get('og:image:type') != ['image/png'] or page.meta.get('twitter:image') != image or page.meta.get('twitter:card') != ['summary_large_image'] or not page.meta.get('og:image:alt') or page.meta.get('twitter:image:alt') != page.meta.get('og:image:alt'):
            errors.append(rel + ': incomplete social image metadata')
        for link in page.links:
            u = urllib.parse.urlparse(urllib.parse.urljoin(canonical, link))
            if u.scheme not in ('http', 'https') or u.netloc != 'gitdocket.com':
                continue
            references += 1
            destination = site / urllib.parse.unquote(u.path.lstrip('/'))
            if destination.is_dir():
                destination /= 'index.html'
            if not destination.is_file() or not destination.resolve().is_relative_to(site.resolve()):
                errors.append(rel + ': missing/unsafe link ' + link)
                continue
            if 'site/' + destination.relative_to(site).as_posix() not in manifest:
                errors.append(rel + ': linked file missing from public export ' + link)
            if u.fragment and destination.suffix == '.html' and urllib.parse.unquote(u.fragment) not in pages[destination].ids:
                errors.append(rel + ': missing fragment ' + link)
            query = urllib.parse.parse_qs(u.query)
            if 'v' in query and query['v'] != [digest(destination.read_bytes())[:12]]:
                errors.append(rel + ': stale asset cache hash ' + link)
            routes[u.path + ('?' + u.query if u.query else '')] = (destination, 200)
    for rel in ('README.md', 'docs/cli.md', 'docs/npm.md', 'docs/homebrew.md', 'docs/extensions.md'):
        text = (root / rel).read_text()
        errors.extend(rel + ': ' + e for e in version_errors(text, version))
        errors.extend(rel + ': ' + e for e in command_status_errors(text.replace('`', '')))
    sitemap = ET.fromstring((site / 'sitemap.xml').read_bytes())
    urls = [x.text for x in sitemap.findall('{http://www.sitemaps.org/schemas/sitemap/0.9}url/{http://www.sitemaps.org/schemas/sitemap/0.9}loc')]
    if set(urls) != set(canonicals) or len(urls) != len(set(urls)):
        errors.append('sitemap differs from authored indexable canonicals')
    if 'Sitemap: ' + APEX + '/sitemap.xml' not in (site / 'robots.txt').read_text():
        errors.append('robots.txt lacks canonical sitemap')
    for rel in ('robots.txt', 'sitemap.xml'):
        routes['/' + rel] = (site / rel, 200)
    for route in ('/site-preflight-missing', '/docs/site-preflight-missing/', '/assets/site-preflight-missing.png'):
        routes[route] = (site / '404.html', 404)
    card = (site / 'assets/social-preview.png').read_bytes()
    if card[:8] != b'\x89PNG\r\n\x1a\n' or int.from_bytes(card[16:20], 'big') != 1200 or int.from_bytes(card[20:24], 'big') != 630:
        errors.append('social card must be a 1200×630 PNG')
    artifact_errors, artifacts = artifact_checks(root, version)
    errors.extend(artifact_errors)
    return errors, routes, {'htmlPages': len(pages), 'localReferences': references, 'canonicalPages': len(canonicals), 'artifacts': artifacts}


def normalize_html(body):
    text = body.decode()
    beacons = re.findall(r'<script\b[^>]*src=["\']https://static\.cloudflareinsights\.com/[^"\']+["\'][^>]*>\s*</script>', text)
    if len(beacons) > 1 or any(not any(f'src={q}{BEACON_URL}{q}' in b and f'integrity={q}{BEACON_INTEGRITY}{q}' in b for q in ('\"', "'")) for b in beacons):
        raise ValueError('unexpected analytics injection')
    for beacon in beacons:
        text = text.replace(beacon, '')
    def decode(value):
        data = bytes.fromhex(value)
        return bytes(x ^ data[0] for x in data[1:]).decode()
    text = re.sub(r'href="/cdn-cgi/l/email-protection#([a-fA-F0-9]+)"', lambda m: 'href="mailto:' + decode(m[1]) + '"', text)
    text = re.sub(r'<span class="__cf_email__" data-cfemail="([a-fA-F0-9]+)">\[email&#160;protected\]</span>', lambda m: decode(m[1]), text)
    if text.count('/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js') > 1:
        raise ValueError('duplicate email decoder injection')
    text = text.replace('<script data-cfasync="false" src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script>', '')
    if beacons:
        text = text.replace('  \n</body>', '  </body>')
    return text.encode()


def response_matches(status, mime, body, path, expected_status):
    normalized = normalize_html(body) if path.suffix == '.html' else body
    return status == expected_status and mime in MIMES[path.suffix] and normalized == path.read_bytes()


def live_checks(routes, base):
    def probe(item):
        route, (path, expected_status) = item
        url = base.rstrip('/') + route
        try:
            try:
                result = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'GitDocket site preflight'}), timeout=20)
            except urllib.error.HTTPError as e:
                result = e
            with result:
                body, status, mime = result.read(), result.status, result.headers.get_content_type()
            if base.rstrip('/') == APEX and path.suffix == '.html' and body.count(BEACON_URL.encode()) != 1:
                raise ValueError('production requires exactly one verified analytics beacon')
            return {'url': url, 'status': status, 'expectedStatus': expected_status, 'mime': mime, 'sha256': digest(body), 'passed': response_matches(status, mime, body, path, expected_status)}
        except Exception as e:
            return {'url': url, 'passed': False, 'error': str(e)}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        return list(pool.map(probe, sorted(routes.items())))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def www_checks():
    opener = urllib.request.build_opener(NoRedirect)
    checks = []
    for scheme in ('http', 'https'):
        for path in ('/', '/docs/install/?via=preflight&mode=read', '/docs/?a=1&a=2', '/site-preflight-missing'):
            url = scheme + '://www.gitdocket.com' + path
            try:
                try:
                    r = opener.open(urllib.request.Request(url, headers={'User-Agent': 'GitDocket site preflight'}), timeout=20)
                except urllib.error.HTTPError as e:
                    r = e
                with r:
                    status, location = r.status, r.headers.get('Location')
                checks.append({'url': url, 'status': status, 'location': location, 'passed': status == 301 and location == APEX + path})
            except Exception as e:
                checks.append({'url': url, 'passed': False, 'error': str(e)})
    return checks


def command_checks(executable, version):
    checks = []
    with tempfile.TemporaryDirectory(prefix='gitdocket-site-preflight-') as tmp:
        def run(args, cli=True):
            command = [str(executable), *args] if cli else ['git', '-c', 'core.hooksPath=/dev/null', *args]
            p = subprocess.run(command, cwd=tmp, capture_output=True, text=True, timeout=30)
            if p.returncode:
                raise ValueError('fixture command failed: ' + ' '.join(args) + ': ' + p.stderr[-400:] + p.stdout[-400:])
            checks.append({'args': args, 'passed': True})
            return p.stdout
        if run(['--version']).strip() != version:
            raise ValueError('selected installed CLI version differs from published baseline')
        run(['init', '-q'], False)
        run(['init', '--project', 'PRE', '--json'])
        task = json.loads(run(['task', 'create', '--title', 'Disposable guide verification', '--compact', '--json']))
        started = json.loads(run(['task', 'start', task['id'], '--json']))
        run(['overview', '--json'])
        run(['task', 'move', task['id'], 'in-review', '--json'])
        run(['task', 'stop', task['id'], '--workflow-token', started['telemetryWorkflow'], '--json'])
        run(['index', '--json'])
        diagnostics = json.loads(run(['lint', '--json']))
        if any(d.get('severity') == 'error' for d in diagnostics):
            raise ValueError('disposable command fixture has lint errors')
    return checks


def browser_check(root, receipt_path):
    receipt = json.loads(receipt_path.read_text())
    required = {'responsive', 'keyboard', 'copy', 'console', 'social'}
    checks = {c['name']: c['status'] for c in receipt.get('checks', [])}
    if receipt.get('schema') != 'gitdocket-site-browser/v1' or any(checks.get(x) != 'passed' for x in required):
        raise ValueError('browser receipt lacks required observed checks')
    inputs = receipt.get('inputs', {})
    must_cover = {'site/styles.css', 'site/copy-install.js', 'site/assets/social-preview.png', *[p.relative_to(root).as_posix() for p in (root / 'site').rglob('*.html')]}
    if not must_cover.issubset(inputs):
        raise ValueError('browser receipt omits affected site inputs')
    if any(not (root / p).resolve().is_relative_to(root.resolve()) for p in inputs):
        raise ValueError('browser receipt has an unsafe input path')
    if any(not (root / p).is_file() or digest((root / p).read_bytes()) != sha for p, sha in inputs.items()):
        raise ValueError('browser receipt is stale: relevant input bytes changed')
    if not all(re.fullmatch(r'[a-f0-9]{40}', receipt.get(k, '')) for k in ('sourceCommit', 'publicCommit')):
        raise ValueError('browser receipt lacks exact source/public revision')
    return {'status': 'passed', 'receiptSha256': digest(receipt_path.read_bytes()), 'observedSource': receipt['sourceCommit'], 'observedPublic': receipt['publicCommit'], 'reusedUnchangedInputs': len(inputs), 'limits': receipt.get('limits', [])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    parser.add_argument('--version', required=True, help='Selected published release, not a development-head guess')
    parser.add_argument('--base-url', help='Optional read-only HTTP checks against an exact preview/production revision')
    parser.add_argument('--www', action='store_true', help='Also verify the real canonical www HTTP/HTTPS redirects')
    parser.add_argument('--docket', type=pathlib.Path, help='Absolute selected published executable; runs only in a disposable fixture')
    parser.add_argument('--browser-receipt', type=pathlib.Path)
    parser.add_argument('--launch', action='store_true', help='Require live, www, installed CLI and browser evidence')
    parser.add_argument('--report', type=pathlib.Path, help='Owned output JSON outside repository source; does not deploy/publish')
    args = parser.parse_args()
    root = args.root.resolve()
    if args.report and (args.report.suffix != '.json' or args.report.resolve().is_relative_to(root)):
        parser.error('--report must be an owned JSON path outside the checked source tree')
    receipt = {'schema': 'gitdocket-site-preflight/v1', 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'selectedPublishedVersion': args.version, 'errors': [], 'limits': ['Historical release/demo evidence and explicitly declared compatibility minimums are exempt from current-release copy checks.', 'No automatic publication or package/platform qualification.', 'External destinations are not byte-compared; same-origin authored links and downloads are checked.', 'Source checks alone do not establish live hosting or manual browser behavior.']}
    def git(*command):
        p = subprocess.run(['git', *command], cwd=root, capture_output=True, text=True)
        return p.stdout.strip() if p.returncode == 0 else None
    receipt['checkoutCommit'] = git('rev-parse', 'HEAD')
    provenance = root / '.gitdocket-source.json'
    receipt['sourceCommit'] = json.loads(provenance.read_text())['sourceCommit'] if provenance.exists() else receipt['checkoutCommit']
    receipt['publicCommit'] = receipt['checkoutCommit'] if provenance.exists() else None
    receipt['workingTreeChanged'] = bool(git('status', '--porcelain'))
    try:
        errors, routes, summary = source_checks(root, args.version)
        receipt['errors'].extend(errors)
        receipt['source'] = summary
        if args.base_url:
            receipt['live'] = live_checks(routes, args.base_url)
            receipt['errors'].extend(c['url'] + ': HTTP/MIME/content mismatch' for c in receipt['live'] if not c['passed'])
        if args.www:
            receipt['www'] = www_checks()
            receipt['errors'].extend(c['url'] + ': canonical redirect mismatch' for c in receipt['www'] if not c['passed'])
        if args.docket:
            if not args.docket.is_absolute():
                raise ValueError('--docket must be an absolute published executable path')
            receipt['commands'] = command_checks(args.docket, args.version)
        if args.browser_receipt:
            receipt['browser'] = browser_check(root, args.browser_receipt)
        if args.launch and not all((args.base_url, args.www, args.docket, args.browser_receipt)):
            raise ValueError('--launch requires --base-url, --www, --docket and --browser-receipt')
    except Exception as e:
        receipt['errors'].append(str(e))
    receipt['passed'] = not receipt['errors']
    if args.report:
        args.report.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({k: receipt.get(k) for k in ('passed', 'sourceCommit', 'publicCommit', 'selectedPublishedVersion', 'source', 'errors')}))
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
