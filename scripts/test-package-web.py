from pathlib import Path
import hashlib
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import tarfile
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import zipfile

spec = importlib.util.spec_from_file_location("package_web", Path(__file__).with_name("package-web.py"))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class WebPackageTests(unittest.TestCase):
    def test_archives_are_versioned_identical_and_repeatable(self):
        with tempfile.TemporaryDirectory(prefix="fairshare-package-") as folder:
            root = Path(folder)
            (root / "package.json").write_text(json.dumps({"version": "2.3.4"}))
            (root / "dist").mkdir()
            (root / "dist" / "index.html").write_text("current build")
            (root / "dist" / "icon.png").write_bytes(b"icon")
            shutil.copytree(Path(__file__).parent / "web", root / "scripts" / "web")
            (root / "android").mkdir()
            (root / "android" / "secret.txt").write_text("not for web")
            first = packager.package_web(root)
            hashes = [hashlib.sha256(path.read_bytes()).digest() for path in first]
            self.assertEqual(hashes, [hashlib.sha256(path.read_bytes()).digest()
                                     for path in packager.package_web(root)])
            with zipfile.ZipFile(first[0]) as archive:
                zipped = {name: archive.read(name) for name in archive.namelist()}
            with tarfile.open(first[1]) as archive:
                tarred = {entry.name: archive.extractfile(entry).read() for entry in archive}
            self.assertEqual(zipped, tarred)
            self.assertEqual(len(zipped), 4)
            self.assertEqual(zipped["FairShare-web-v2.3.4/public/index.html"], b"current build")
            self.assertIn(b"FairShare web 2.3.4", zipped["FairShare-web-v2.3.4/README.txt"])
            with zipfile.ZipFile(first[0]) as archive:
                archive.extractall(root / "extracted")
            subprocess.run(["node", "--check", str(root / "extracted" / "FairShare-web-v2.3.4" / "server.mjs")],
                           check=True)
            self.check_server(root / "extracted" / "FairShare-web-v2.3.4")

    def check_server(self, folder):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        server = subprocess.Popen(
            ["node", str(folder / "server.mjs")],
            env={**os.environ, "PORT": str(port), "HOST": "127.0.0.1"},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        origin = f"http://127.0.0.1:{port}"
        try:
            for attempt in range(50):
                try:
                    with urllib.request.urlopen(origin, timeout=1) as response:
                        self.assertEqual(response.read(), b"current build")
                    break
                except urllib.error.URLError:
                    if server.poll() is not None:
                        self.fail(f"Server exited: {server.communicate()}")
                    time.sleep(0.1)
            else:
                self.fail("Server did not become ready")
            for route in ("/dashboard", "/group/example"):
                with urllib.request.urlopen(origin + route) as response:
                    self.assertEqual(response.read(), b"current build")
                    self.assertEqual(response.headers["Cache-Control"], "no-cache")
            with urllib.request.urlopen(origin + "/icon.png") as response:
                self.assertEqual(response.read(), b"icon")
                self.assertEqual(response.headers["Content-Type"], "image/png")
            with urllib.request.urlopen(urllib.request.Request(origin, method="HEAD")) as response:
                self.assertEqual(response.read(), b"")
            for route, status in (("/missing.js", 404), ("/%zz", 400),
                                  ("/%2e%2e%5cpackage.json", 400)):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(origin + route)
                self.assertEqual(error.exception.code, status)
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(origin, method="POST", data=b"test"))
            self.assertEqual(error.exception.code, 405)
        finally:
            server.terminate()
            server.communicate(timeout=10)

    def test_missing_build_is_reported(self):
        with tempfile.TemporaryDirectory(prefix="fairshare-package-") as folder:
            root = Path(folder)
            (root / "package.json").write_text('{"version":"1.0.0"}')
            with self.assertRaises(FileNotFoundError):
                packager.package_web(root)


if __name__ == "__main__":
    unittest.main()
