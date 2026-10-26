"""Pin every download of the local runtime packs.

Reads packages/vulcan-decision/runtime-packs/spec.json and writes one <pack>.json lock file next to
it. Each lock lists, per target, a prebuilt python-build-standalone interpreter and the exact
official wheels uv resolves for that platform, with their URL, size and SHA-256. The installer
downloads exactly these files and refuses anything else; nothing is ever compiled.

Needs uv on PATH and network access to GitHub, PyPI and download.pytorch.org. Run it with
`python -I -B scripts/lock_runtime.py [pack ...]`.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKS = ROOT / 'packages' / 'vulcan-decision' / 'runtime-packs'
PBS = 'https://github.com/astral-sh/python-build-standalone/releases/download'
USER_AGENT = 'vulcan-decision-lock/1'


def http(url: str, method: str = 'GET') -> urllib.request.addinfourl:
    request = urllib.request.Request(url, method=method, headers={'User-Agent': USER_AGENT})
    return urllib.request.urlopen(request, timeout=120)


def remote_size(url: str) -> int:
    with http(url, 'HEAD') as response:
        length = response.headers.get('Content-Length')
    if length is None:
        raise RuntimeError(f'{url} reports no size')
    return int(length)


def python_sums(release: str) -> dict[str, str]:
    with http(f'{PBS}/{release}/SHA256SUMS') as response:
        text = response.read().decode('utf-8')
    sums = {}
    for line in text.splitlines():
        digest, _, name = line.strip().partition('  ')
        if digest and name:
            sums[name] = digest
    return sums


def python_file(release: str, version: str, triple: str, sums: dict[str, str]) -> dict:
    name = f'cpython-{version}+{release}-{triple}-install_only_stripped.tar.gz'
    if name not in sums:
        raise RuntimeError(f'{name} is not in the {release} release')
    url = f'{PBS}/{release}/{urllib.parse.quote(name)}'
    return {'kind': 'python', 'name': name, 'url': url, 'bytes': remote_size(url), 'sha256': sums[name]}


def wheel_preference(wheel: dict) -> tuple:
    """Rank compatible wheels like pip: a platform wheel over a pure one, a version-specific ABI over
    abi3, and the newest platform version (macOS, manylinux glibc) the target still supports."""
    name = urllib.parse.unquote(wheel['url'].rsplit('/', 1)[1])[:-len('.whl')]
    _, _, abi, plat = name.rsplit('-', 3)
    versions = [tuple(int(part) for part in match) for match in re.findall(r'_(\d+)_(\d+)_', plat + '_')]
    return (plat != 'any', abi not in ('abi3', 'none'), max(versions, default=(0, 0)))


def resolve_wheels(pack: dict, target: str, info: dict) -> list[dict]:
    requirements = list(pack['requirements'])
    for override in pack.get('requirements_by_target', {}).get(target, []):
        name = override.split('==')[0].split('[')[0]
        requirements = [line for line in requirements if line.split('==')[0].split('[')[0] != name] + [override]
    with tempfile.TemporaryDirectory() as work:
        work_dir = Path(work)
        (work_dir / 'requirements.txt').write_text('\n'.join(requirements) + '\n', encoding='utf-8')
        command = ['uv', 'pip', 'compile', str(work_dir / 'requirements.txt'), '--quiet', '--no-header',
                   '--python-version', pack['python'], '--python-platform', info['uv_platform'],
                   '--only-binary', ':all:', '--index-url', 'https://pypi.org/simple',
                   '-o', str(work_dir / 'pylock.toml')]
        if 'constraints' in pack:
            command += ['-c', str(PACKS / pack['constraints'])]
        if 'find_links' in pack:
            command += ['--find-links', pack['find_links']]
        # uv reads the lowest macOS version to resolve for from the deployment target.
        env = {**os.environ, **({'MACOSX_DEPLOYMENT_TARGET': info['macos']} if 'macos' in info else {})}
        subprocess.run(command, check=True, env=env)
        lock = tomllib.loads((work_dir / 'pylock.toml').read_text(encoding='utf-8'))
    files = []
    for package in lock['packages']:
        wheels = package.get('wheels', [])
        if not wheels:
            raise RuntimeError(f'{package["name"]} resolved to no wheel for {target}')
        # Several compatible wheels can match; take the one pip ranks first.
        wheel = max(wheels, key=wheel_preference)
        url = wheel['url']
        name = urllib.parse.unquote(url.rsplit('/', 1)[1])
        size = wheel.get('size')
        files.append({'kind': 'wheel', 'name': name, 'url': url,
                      'bytes': size if size is not None else remote_size(url),
                      'sha256': wheel['hashes']['sha256']})
    return sorted(files, key=lambda item: item['name'].lower())


def lock_pack(pack_id: str, spec: dict, sums: dict[str, str]) -> dict:
    pack = spec['packs'][pack_id]
    targets = {}
    for target in pack['targets']:
        info = spec['targets'][target]
        print(f'{pack_id}: resolving {target}', file=sys.stderr)
        files = [python_file(spec['python_release'], pack['python'], info['pbs'], sums)]
        files += resolve_wheels(pack, target, info)
        targets[target] = {'bytes': sum(item['bytes'] for item in files),
                           **({'macos': info['macos']} if 'macos' in info else {}), 'files': files}
    lock = {'format': 1, 'pack': pack_id, 'backend': pack['backend'], 'device': pack['device'],
            'python': pack['python'], 'requires': pack.get('requires', {}), 'targets': targets}
    # The lock id names one exact file set, so an installed pack knows whether it is current.
    canonical = json.dumps(lock, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return {'id': hashlib.sha256(canonical).hexdigest()[:16], **lock}


def main() -> None:
    spec = json.loads((PACKS / 'spec.json').read_text(encoding='utf-8'))
    selected = sys.argv[1:] or list(spec['packs'])
    unknown = [name for name in selected if name not in spec['packs']]
    if unknown:
        raise SystemExit(f'unknown pack: {", ".join(unknown)}')
    sums = python_sums(spec['python_release'])
    for pack_id in selected:
        lock = lock_pack(pack_id, spec, sums)
        out = PACKS / f'{pack_id}.json'
        out.write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')
        sizes = ', '.join(f'{target} {data["bytes"] / 1024 ** 2:.0f} MiB' for target, data in lock['targets'].items())
        print(f'{pack_id}: {sizes}', file=sys.stderr)


if __name__ == '__main__':
    main()
