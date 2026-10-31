"""Download raw WAVs from 국립국악원 국악기 디지털 음원 (https://www.gugak.go.kr/digitaleum).

License: 공공누리 제1유형 (KOGL Type 1, attribution). The site asks for a purpose/organisation
form before each download; we submit it with the same values a human would type for this project.

Endpoints (reverse-engineered from the list pages, 2026-10):
  POST /digitaleum/front/{monotone|extend}/getInstrumentList.do          -> {"list": [...]}
  POST /digitaleum/front/{monotone|extend}/getFileList.do  instrCd=...   -> {"list": [...], "divList": [...]}
  POST /digitaleum/cmmn/file/{monotone|extend}/download.do  id=<seq> + form   -> one WAV
  POST /digitaleum/cmmn/file/{monotone|extend}/downloads.do arrId=a,b,c + form -> ZIP (<=30 ids)
Form fields: usePurposeGb (상업용|비상업용), usePurpose (교육용|어플리케이션 제작|음악 제작|연구용|기타),
usePurposeDtl (only for 기타), companyName.

Files land in .samples-cache/gugak/{monotone|extend}/<original name>.wav. If you downloaded manually
through the website, drop the WAVs there with their original names and the build scripts will pick them up.

Usage: python scripts/samples/gugak_download.py            # fetch everything the four sets need
       python scripts/samples/gugak_download.py --list monotone 19847   # print a file list
"""
from __future__ import annotations

import http.cookiejar
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CACHE, log  # noqa: E402

BASE = "https://www.gugak.go.kr"
GUGAK_CACHE = CACHE / "gugak"
BATCH = 30
BATCH_DELAY = 1.5
FORM = {
    "usePurposeGb": "상업용",
    "usePurpose": "어플리케이션 제작",
    "usePurposeDtl": "",
    "companyName": "가락이음(오픈소스 DAW)",
}

# monotone instrCd
INSTR = {"용고": "19843", "좌고": "19849", "박": "19834", "장구": "19847", "꽹과리": "19828", "바라": "19833",
         "징": "19859", "해금": "19870", "산조대금": "19915", "정악대금": "19917"}
EXTEND_GAYAGEUM = "EXTEND0005"


class Session:
    def __init__(self) -> None:
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.op.addheaders = [("User-Agent", "Mozilla/5.0 garak-ieum-samples/1.0")]
        self.warm = set()

    def _warm(self, section: str) -> None:
        if section not in self.warm:
            self.op.open(f"{BASE}/digitaleum/front/{section}/list.do", timeout=60).read()
            self.warm.add(section)

    def post(self, path: str, data: dict, section: str, ajax: bool = False) -> urllib.response.addinfourl:
        self._warm(section)
        headers = {"Referer": f"{BASE}/digitaleum/front/{section}/list.do"}
        if ajax:
            headers["X-Requested-With"] = "XMLHttpRequest"
        req = urllib.request.Request(BASE + path, data=urllib.parse.urlencode(data).encode(), headers=headers)
        return self.op.open(req, timeout=300)

    def file_list(self, section: str, instr_cd: str) -> dict:
        cache = GUGAK_CACHE / "lists" / f"{section}_{instr_cd}.json"
        if cache.exists():
            return json.loads(cache.read_text(encoding="utf-8"))
        data = json.loads(self.post(f"/digitaleum/front/{section}/getFileList.do", {"instrCd": instr_cd}, section, ajax=True).read().decode("utf-8"))
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        return data


def seq_of(item: dict) -> int:
    return int(item.get("mntnSeq") or item.get("extendSeq"))


def name_of(item: dict) -> str:
    return item.get("wavFileName") or Path(item["wavFilePath"]).name


def _dest(section: str, name: str) -> Path:
    return GUGAK_CACHE / section / name


def _save_response(section: str, r, fallback_name: str) -> list[Path]:
    body = r.read()
    ctype = r.headers.get("Content-Type", "")
    disp = r.headers.get("Content-Disposition", "")
    m = re.search(r"filename\*=UTF-8''([^;]+)", disp) or re.search(r'filename="?([^";]+)"?', disp)
    fname = urllib.parse.unquote(m.group(1)) if m else fallback_name
    if body[:2] == b"PK" or "zip" in ctype:
        out = []
        with zipfile.ZipFile(io.BytesIO(body)) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                try:
                    nm = Path(info.filename.encode("cp437").decode("utf-8")).name
                except Exception:
                    nm = Path(info.filename).name
                p = _dest(section, nm)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(z.read(info))
                out.append(p)
        return out
    if body[:4] != b"RIFF" and not ctype.startswith("audio"):
        raise RuntimeError(f"unexpected response ({ctype}, {len(body)} bytes): {body[:200]!r}")
    p = _dest(section, fname)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(body)
    return [p]


def ensure(section: str, items: list[dict], session: Session | None = None) -> dict[int, Path]:
    """Make sure every item (from file_list) is on disk; returns seq -> path."""
    session = session or Session()
    have: dict[int, Path] = {}
    missing: list[dict] = []
    for it in items:
        p = _dest(section, name_of(it))
        if p.exists() and p.stat().st_size > 0:
            have[seq_of(it)] = p
        else:
            missing.append(it)
    for i in range(0, len(missing), BATCH):
        chunk = missing[i:i + BATCH]
        ids = [seq_of(x) for x in chunk]
        log(f"download {section} {ids}")
        try:
            if len(ids) == 1:
                r = session.post(f"/digitaleum/cmmn/file/{section}/download.do", {**FORM, "arrId": "", "id": ids[0]}, section)
                _save_response(section, r, name_of(chunk[0]))
            else:
                r = session.post(f"/digitaleum/cmmn/file/{section}/downloads.do", {**FORM, "arrId": ",".join(map(str, ids)), "id": ""}, section)
                _save_response(section, r, "batch.zip")
        except Exception as e:  # fall back to single downloads
            log("batch failed, falling back to single downloads:", e)
            for it in chunk:
                r = session.post(f"/digitaleum/cmmn/file/{section}/download.do", {**FORM, "arrId": "", "id": seq_of(it)}, section)
                _save_response(section, r, name_of(it))
                time.sleep(BATCH_DELAY)
        for it in chunk:
            p = _dest(section, name_of(it))
            if not p.exists():
                raise FileNotFoundError(f"{section} {seq_of(it)} ({name_of(it)}) not found after download")
            have[seq_of(it)] = p
        if i + BATCH < len(missing):
            time.sleep(BATCH_DELAY)
    return have


def monotone_items(instr: str, seqs: list[int] | None = None, session: Session | None = None) -> list[dict]:
    session = session or Session()
    items = session.file_list("monotone", INSTR[instr])["list"]
    if seqs is not None:
        items = [x for x in items if seq_of(x) in set(seqs)]
    return items


def gayageum_single_notes(session: Session | None = None) -> list[dict]:
    session = session or Session()
    items = session.file_list("extend", EXTEND_GAYAGEUM)["list"]
    return [x for x in items if "Gayageum_SingleNote1_" in x.get("wavFilePath", "")]


CHANGES = ("음 단위 분할, 트리밍, 페이드, 음량 정규화, Opus/AAC 변환, 일부 음정 보정. "
           "국립국악원은 본 프로젝트를 후원·보증하지 않습니다.")


def attribution(performers: str | None = None) -> dict:
    a = {
        "title": "국악기 디지털 음원 (단음/확장)",
        "author": "국립국악원 (National Gugak Center)",
        "url": "https://www.gugak.go.kr/digitaleum",
        "license": "공공누리 제1유형 (KOGL Type 1, 출처표시)",
        "licenseUrl": "https://www.kogl.or.kr/info/licenseType1.do",
        "changes": CHANGES,
    }
    if performers:
        a["performers"] = performers
    return a


def write_license(set_id: str, sources: list[str], performers: str | None = None) -> Path:
    from common import PUBLIC
    lines = [
        "본 저작물은 '국립국악원'에서 작성하여 공공누리 제1유형으로 개방한 '국악기 디지털 음원'을 이용하였으며, "
        "해당 저작물은 '국립국악원, https://www.gugak.go.kr/digitaleum'에서 무료로 내려받으실 수 있습니다.",
        "",
        "공공누리 제1유형 (출처표시): https://www.kogl.or.kr/info/licenseType1.do",
        "",
    ]
    if performers:
        lines += [f"연주: {performers}", ""]
    lines += ["사용한 원본 파일:"] + [f"  - {s}" for s in sources]
    lines += ["", f"변경 사항: {CHANGES}", ""]
    out = PUBLIC / set_id / "LICENSE.txt"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    return out


# Everything the four set scripts consume.
SAMUL_SEQS = {
    "용고": [2276, 2277, 2278], "좌고": [2305, 2306, 2307], "박": [2258],
    "장구": list(range(2282, 2291)) + list(range(2294, 2300)),
    "꽹과리": list(range(2213, 2228)), "바라": [2254, 2255, 2256], "징": [2334, 2335],
}
HAEGEUM_SEQS = [2406, 2474, 2482]  # Haegeum_1 중 / _2 약 / _10 강
DAEGEUM_SEQS = [2550, 2557]  # sanjo sus_04, jungak sus_25


def fetch_all() -> None:
    s = Session()
    for instr, seqs in SAMUL_SEQS.items():
        ensure("monotone", monotone_items(instr, seqs, s), s)
    ensure("monotone", monotone_items("해금", HAEGEUM_SEQS, s), s)
    ensure("monotone", monotone_items("산조대금", [2550], s) + monotone_items("정악대금", [2557], s), s)
    ensure("extend", gayageum_single_notes(s), s)


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--list":
        sys.stdout.reconfigure(encoding="utf-8")
        for x in Session().file_list(sys.argv[2], sys.argv[3])["list"]:
            print(seq_of(x), x.get("division"), "|", x.get("subDivision") or x.get("extendDescKor"), "|", name_of(x))
    else:
        fetch_all()
        n = sum(1 for _ in GUGAK_CACHE.rglob("*.wav"))
        log(f"done: {n} wav files in {GUGAK_CACHE}")
