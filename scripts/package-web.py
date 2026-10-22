from pathlib import Path
import hashlib
import gzip
import io
import json
import re
import tarfile
import zipfile


def package_web(root):
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version):
        raise ValueError("version must use major.minor.patch")
    dist = root / "dist"
    if not (dist / "index.html").is_file():
        raise FileNotFoundError("Build the web app before packaging.")
    name = f"FairShare-web-v{version}"
    contents = {}
    for path in sorted(dist.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Refusing to package a symlink: {path}")
        if path.is_file():
            contents[f"{name}/public/{path.relative_to(dist).as_posix()}"] = path.read_bytes()
    contents[f"{name}/server.mjs"] = (root / "scripts" / "web" / "server.mjs").read_bytes()
    instructions = (root / "scripts" / "web" / "README.txt").read_text(encoding="utf-8")
    contents[f"{name}/README.txt"] = instructions.replace("{{VERSION}}", version).encode("utf-8")
    output = root / "releases"
    output.mkdir(exist_ok=True)
    zip_path = output / f"{name}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for filename, content in sorted(contents.items()):
            entry = zipfile.ZipInfo(filename)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, content)
    tar_path = output / f"{name}.tar.gz"
    with tar_path.open("wb") as compressed:
        with gzip.GzipFile(filename="", fileobj=compressed, mode="wb", mtime=0) as stream:
            with tarfile.open(fileobj=stream, mode="w") as archive:
                for filename, content in sorted(contents.items()):
                    entry = tarfile.TarInfo(filename)
                    entry.size = len(content)
                    entry.mode = 0o644
                    archive.addfile(entry, io.BytesIO(content))
    checksums = "".join(
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
        for path in (zip_path, tar_path)
    )
    (output / f"{name}-SHA256SUMS.txt").write_text(checksums, encoding="utf-8")
    print(checksums, end="")
    return zip_path, tar_path


if __name__ == "__main__":
    package_web(Path(__file__).resolve().parents[1])
