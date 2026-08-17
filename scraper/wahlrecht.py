#!/usr/bin/env python3
"""Scraper for German election polls from wahlrecht.de.

Fetches federal polls (per-institute pages incl. per-legislature archives)
and state-level polls (one page per Bundesland), normalizes them and writes
one JSON file per region into web/data/.

Stdlib only — no third-party dependencies.
"""

from __future__ import annotations

import argparse
import hashlib
import html as htmllib
import json
import os
import re
import sys
import time
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

BASE = "https://www.wahlrecht.de/umfragen/"
USER_AGENT = "pollity/1.0 (+https://github.com/ch-sc/pollity; poll aggregation research)"
FETCH_DELAY_S = 0.4

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "web" / "data"

# Federal institute pages: slug -> canonical institute name.
FEDERAL_INSTITUTES = {
    "allensbach": "Allensbach",
    "emnid": "Verian (Emnid)",
    "forsa": "Forsa",
    "politbarometer": "Forschungsgruppe Wahlen",
    "gms": "GMS",
    "dimap": "Infratest dimap",
    "insa": "INSA",
    "yougov": "YouGov",
    "ipsos": "Ipsos",
}

STATES = {
    "baden-wuerttemberg": "Baden-Württemberg",
    "bayern": "Bayern",
    "berlin": "Berlin",
    "brandenburg": "Brandenburg",
    "bremen": "Bremen",
    "hamburg": "Hamburg",
    "hessen": "Hessen",
    "mecklenburg-vorpommern": "Mecklenburg-Vorpommern",
    "niedersachsen": "Niedersachsen",
    "nrw": "Nordrhein-Westfalen",
    "rheinland-pfalz": "Rheinland-Pfalz",
    "saarland": "Saarland",
    "sachsen": "Sachsen",
    "sachsen-anhalt": "Sachsen-Anhalt",
    "schleswig-holstein": "Schleswig-Holstein",
    "thueringen": "Thüringen",
}

# Normalize party labels across pages and decades.
PARTY_ALIASES = {
    "GRÜNE": "GRÜNE",
    "GRÜNE/B 90": "GRÜNE",
    "B 90/GRÜNE": "GRÜNE",
    "B90/GRÜNE": "GRÜNE",
    "BÜNDNIS 90/DIE GRÜNEN": "GRÜNE",
    "GRÜNE/GAL": "GRÜNE",
    "GAL": "GRÜNE",
    "DIE LINKE": "LINKE",
    "LINKE.PDS": "LINKE",
    "LINKE/PDS": "LINKE",
    "PDS": "LINKE",
    "WASG": "LINKE",
    "CDU/CSU": "CDU/CSU",
    "FREIE WÄHLER": "FW",
    "FWG": "FW",
    "SONSTIGE": "Sonstige",
    # Forsa (Bund) reports the share of non-voters/undecided among ALL
    # eligible voters — a different base than the party shares, kept as its
    # own series rather than dropped.
    "NICHTWÄHLER/ UNENTSCHL.": "Nichtwähler/Unentschl.",
    "NICHTWÄHLER/UNENTSCHL.": "Nichtwähler/Unentschl.",
    "NICHTWÄHLER": "Nichtwähler/Unentschl.",
    "SONST.": "Sonstige",
    "ANDERE": "Sonstige",
    "REP/DVU": "REP",
}

# Institute names as they appear in state-table cells -> canonical.
INSTITUTE_ALIASES = {
    "infratest dimap": "Infratest dimap",
    "infratest": "Infratest dimap",
    "infratest burke": "Infratest dimap",
    "dimap": "Infratest dimap",
    "forsch'gr. wahlen": "Forschungsgruppe Wahlen",
    "forsch'gr.wahlen": "Forschungsgruppe Wahlen",
    "forschungsgruppe wahlen": "Forschungsgruppe Wahlen",
    "fgw": "Forschungsgruppe Wahlen",
    "emnid": "Verian (Emnid)",
    "tns emnid": "Verian (Emnid)",
    "kantar emnid": "Verian (Emnid)",
    "kantar": "Verian (Emnid)",
    "verian": "Verian (Emnid)",
    "insa": "INSA",
    "yougov": "YouGov",
    "gms": "GMS",
    "forsa": "Forsa",
    "allensbach": "Allensbach",
    "ipsos": "Ipsos",
    "gess": "GESS",
    "polis": "Polis",
    "polis+sinus": "Polis",
    "psephos": "Psephos",
    "uniqma": "UniQma",
    "pollytix": "pollytix",
    "civey": "Civey",
    "wahlkreisprognose": "Wahlkreisprognose",
    "uni jena": "Uni Jena",
    "aproxima": "aproxima",
    "mafo.de": "mafo.de",
    "customer research 42": "Customer Research 42",
    "trend research": "Trend Research",
    "leipziger institut für marktforschung": "Leipziger Institut",
    "institut für marktforschung leipzig": "Leipziger Institut",
}

META_HEADERS = {"institut", "auftraggeber", "befragte", "datum", "zeitraum", ""}
# Meta columns are sometimes labelled differently (e.g. "Quelle", "Auftraggeber bzw. Quelle").
META_KEYWORDS = ("institut", "auftraggeber", "quelle", "befragte", "datum", "zeitraum")


def is_meta_header(label: str) -> bool:
    hl = label.strip().lower()
    return hl in META_HEADERS or any(k in hl for k in META_KEYWORDS)

# Columns that are neither parties nor the non-voter series.
DROP_COLUMNS = {"unentschlossene", "unentschieden"}


def fetch(url: str, cache_dir: Path | None) -> str:
    """Fetch a URL as text, with optional on-disk caching for development."""
    cache_file = None
    if cache_dir:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / (hashlib.sha1(url.encode()).hexdigest() + ".html")
        if cache_file.exists():
            return cache_file.read_text(encoding="utf-8")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    text = raw.decode("utf-8", errors="replace")
    if cache_file:
        cache_file.write_text(text, encoding="utf-8")
    time.sleep(FETCH_DELAY_S)
    return text


# ---------------------------------------------------------------------------
# HTML table parsing (regex-based; wahlrecht.de markup is machine-generated
# and very regular — every poll table is <table class="wilko">).
# ---------------------------------------------------------------------------

def strip_tags(fragment: str) -> str:
    fragment = re.sub(r"<br\s*/?>", " ", fragment, flags=re.I)
    fragment = re.sub(r"<[^>]+>", "", fragment)
    text = htmllib.unescape(fragment)
    text = text.replace(" ", " ").replace("•", " ")
    return re.sub(r"\s+", " ", text).strip()


def parse_tables(html: str) -> list[dict]:
    """Return every wilko table as {'headers': [...], 'rows': [[(text, attrs)...]]}."""
    tables = []
    for tm in re.finditer(r'<table class="wilko".*?</table>', html, re.S):
        thtml = re.sub(r"<tfoot>.*?</tfoot>", "", tm.group(0), flags=re.S)
        thead = re.search(r"<thead>(.*?)</thead>", thtml, re.S)
        if thead:
            header_html = thead.group(1)
            body = thtml.replace(thead.group(0), "")
        else:
            # Some pages (e.g. insa.htm) omit <thead>; first row holds the <th> cells.
            first_tr = re.search(r"<tr[^>]*>.*?</tr>", thtml, re.S)
            if not first_tr or "<th" not in first_tr.group(0):
                continue
            header_html = first_tr.group(0)
            body = thtml.replace(first_tr.group(0), "", 1)
        # Expand header colspans so header index == expanded row-cell index
        # (Bremen uses colspan=2 party columns with city/Bremerhaven sub-cells).
        headers = []
        for hm in re.finditer(r"<th([^>]*)>(.*?)</th>", header_html, re.S):
            cs = re.search(r'colspan="(\d+)"', hm.group(1))
            headers.append(strip_tags(hm.group(2)))
            headers.extend([""] * ((int(cs.group(1)) if cs else 1) - 1))
        if not headers:
            continue
        rows = []
        for rm in re.finditer(r"<tr[^>]*>(.*?)</tr>", body, re.S):
            cells = []
            for cm in re.finditer(r"<td([^>]*)>(.*?)</td>", rm.group(1), re.S):
                attrs, inner = cm.group(1), cm.group(2)
                colspan = re.search(r'colspan="(\d+)"', attrs)
                cells.append({
                    "text": strip_tags(inner),
                    "html": inner,
                    "class": (re.search(r'class="([^"]*)"', attrs) or [None, ""])[1],
                    "colspan": int(colspan.group(1)) if colspan else 1,
                })
            if cells:
                rows.append(cells)
        tables.append({"headers": headers, "rows": rows})
    return tables


def norm_party(label: str) -> str:
    label = re.sub(r"\s+", " ", label).strip().rstrip("*").strip()
    return PARTY_ALIASES.get(label.upper(), label)


def norm_institute(label: str) -> str:
    clean = re.sub(r"\s+", " ", label).strip().rstrip("*").strip()
    key = clean.lower()
    if key in INSTITUTE_ALIASES:
        return INSTITUTE_ALIASES[key]
    # Cell line-breaks split hyphenated names ("Forschungs-<br>gruppe Wahlen")
    dehyph = key.replace("- ", "")
    if dehyph in INSTITUTE_ALIASES:
        return INSTITUTE_ALIASES[dehyph]
    return clean


def parse_pct(text: str) -> float | None:
    """Parse a single percentage cell like '23 %' or '24,1 %'; None if missing."""
    text = text.strip()
    if not text or text in {"–", "—", "-", "?", "."}:
        return None
    m = re.search(r"(\d+(?:,\d+)?)\s*%?", text)
    if not m:
        return None
    return float(m.group(1).replace(",", "."))


def sum_all_pcts(text: str) -> float | None:
    """Sum every 'N %' in a composite cell (Sonstige breakdowns in election rows)."""
    vals = re.findall(r"(\d+(?:,\d+)?)\s*%", text)
    if not vals:
        return None
    return round(sum(float(v.replace(",", ".")) for v in vals), 1)


def parse_date_de(text: str) -> str | None:
    m = re.search(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", text)
    if not m:
        return None
    d, mth, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        return date(y, mth, d).isoformat()
    except ValueError:
        return None


def parse_sample(text: str) -> int | None:
    """Extract sample size like '1.000' / 'TOM • 2.604 03.08.–08.08.'."""
    for m in re.finditer(r"(\d{1,3}(?:\.\d{3})+|\d{3,6})", text):
        # Skip fragments that are part of a date (followed/preceded by a dot-day)
        n = int(m.group(1).replace(".", ""))
        if 100 <= n <= 200_000:
            return n
    return None


# ---------------------------------------------------------------------------
# Page-level extraction
# ---------------------------------------------------------------------------

def party_columns(headers: list[str]) -> list[tuple[int, str]]:
    """Map header index -> normalized party name for non-meta columns."""
    out = []
    for i, h in enumerate(headers):
        base = h.strip()
        if is_meta_header(base) or base.lower() in DROP_COLUMNS or base in {"", " "}:
            continue
        out.append((i, norm_party(base)))
    return out


def expand_row(cells: list[dict], ncols: int) -> list[dict | None]:
    """Expand colspans so cell index aligns with header index."""
    out: list[dict | None] = []
    for c in cells:
        out.append(c)
        for _ in range(c["colspan"] - 1):
            out.append(None)
    while len(out) < ncols:
        out.append(None)
    return out[:ncols]


def is_footnote_row(cells: list[dict]) -> bool:
    return any("foot" in (c["class"] or "") for c in cells)


def read_results(row: list[dict | None], pcols: list[tuple[int, str]]) -> dict:
    """Read party values from an expanded row. 'Sonstige' cells may hold a
    breakdown like 'BSW 3 % Sonst. 8 %' — sum every percentage in that case."""
    results = {}
    for i, party in pcols:
        cell = row[i]
        if cell is None:
            continue
        val = (sum_all_pcts(cell["text"]) if party == "Sonstige"
               else parse_pct(cell["text"]))
        if val is not None:
            results[party] = val
    return results


def extract_state_page(html: str) -> tuple[list[dict], list[dict]]:
    """Parse a Landtag page: returns (polls, elections)."""
    polls, elections = [], []
    for table in parse_tables(html):
        headers = table["headers"]
        pcols = party_columns(headers)
        if not pcols:
            continue
        ncols = len(headers)
        lower = [h.lower() for h in headers]
        idx = {}
        for name, keys in (("institut", ("institut",)), ("auftraggeber", ("auftraggeber", "quelle")),
                           ("befragte", ("befragte",)), ("datum", ("datum",))):
            for i, h in enumerate(lower):
                if any(k in h for k in keys):
                    idx[name] = i
                    break
        if "datum" not in idx or "institut" not in idx:
            continue
        for cells in table["rows"]:
            if is_footnote_row(cells):
                continue
            row = expand_row(cells, ncols)
            first = cells[0]
            # Election row: leading cell spans the meta columns, e.g.
            # "Landtagswahl am 20.03.2011"
            if first["colspan"] > 1 and "wahl" in first["text"].lower():
                edate = parse_date_de(first["text"])
                if not edate:
                    continue
                results = read_results(row, pcols)
                if results:
                    elections.append({"date": edate, "results": results})
                continue
            institute = norm_institute(first["text"])
            dcell = row[idx["datum"]]
            pdate = parse_date_de(dcell["text"]) if dcell else None
            if not institute or not pdate:
                continue  # also skips city/Bremerhaven continuation rows
            results = read_results(row, pcols)
            if not results:
                continue
            ccell = row[idx["auftraggeber"]] if "auftraggeber" in idx else None
            bcell = row[idx["befragte"]] if "befragte" in idx else None
            polls.append({
                "institute": institute,
                "client": ccell["text"] if ccell and ccell["text"] else None,
                "date": pdate,
                "sample": parse_sample(bcell["text"]) if bcell else None,
                "results": results,
            })
    return polls, elections


def extract_federal_page(html: str, institute: str) -> tuple[list[dict], list[dict]]:
    """Parse a federal institute page: Datum | spacer | parties… | spacer | Befragte | Zeitraum."""
    polls, elections = [], []
    for table in parse_tables(html):
        headers = table["headers"]
        pcols = party_columns(headers)
        if not pcols:
            continue
        ncols = len(headers)
        # Index of the Befragte column, if present.
        befr_idx = next((i for i, h in enumerate(headers) if h.lower() == "befragte"), None)
        for cells in table["rows"]:
            if is_footnote_row(cells):
                continue
            row = expand_row(cells, ncols)
            first = cells[0]
            pdate = parse_date_de(first["text"])
            if not pdate:
                continue
            is_election = any("wahl" in (c["text"] or "").lower() and "w" in (c["class"] or "")
                              for c in cells) or any(
                              "bundestagswahl" in (c["html"] or "").lower() for c in cells)
            results = read_results(row, pcols)
            if not results:
                continue
            if is_election:
                elections.append({"date": pdate, "results": results})
            else:
                polls.append({
                    "institute": institute,
                    "client": None,
                    "date": pdate,
                    "sample": parse_sample(row[befr_idx]["text"]) if befr_idx is not None and row[befr_idx] else None,
                    "results": results,
                })
    return polls, elections


def discover_archives(html: str, slug: str) -> list[str]:
    """Find per-legislature archive subpages like insa/2013.htm on an institute page."""
    links = set(re.findall(rf'href="({re.escape(slug)}/[a-z-]*\d{{4}}[a-z-]*\.htm)"', html))
    # Exclude the Politbarometer "Stimmung" series — a different measure than
    # the published projection and not comparable across institutes.
    return sorted(l for l in links if "stimmung" not in l)


# ---------------------------------------------------------------------------
# Region assembly
# ---------------------------------------------------------------------------

def dedupe(items: list[dict], keyfn) -> list[dict]:
    seen, out = set(), []
    for it in items:
        k = keyfn(it)
        if k in seen:
            continue
        seen.add(k)
        out.append(it)
    return out


def scrape_federal(cache_dir: Path | None, log) -> dict:
    all_polls, all_elections = [], []
    for slug, institute in FEDERAL_INSTITUTES.items():
        url = BASE + slug + ".htm"
        try:
            html = fetch(url, cache_dir)
        except Exception as e:
            log(f"  WARN: failed to fetch {url}: {e}")
            continue
        pages = [html]
        for sub in discover_archives(html, slug):
            try:
                pages.append(fetch(BASE + sub, cache_dir))
            except Exception as e:
                log(f"  WARN: failed to fetch {BASE + sub}: {e}")
        p_count = 0
        for page in pages:
            polls, elections = extract_federal_page(page, institute)
            all_polls.extend(polls)
            all_elections.extend(elections)
            p_count += len(polls)
        log(f"  {institute}: {p_count} polls ({len(pages)} page(s))")
    all_polls = dedupe(all_polls, lambda p: (p["institute"], p["date"], tuple(sorted(p["results"].items()))))
    all_elections = dedupe(all_elections, lambda e: e["date"])
    all_elections.sort(key=lambda e: e["date"])
    all_polls.sort(key=lambda p: p["date"])
    return {
        "key": "bund",
        "name": "Bund (Bundestagswahl)",
        "level": "federal",
        "source": BASE,
        "polls": all_polls,
        "elections": all_elections,
    }


def scrape_state(slug: str, name: str, cache_dir: Path | None, log) -> dict | None:
    url = BASE + "landtage/" + slug + ".htm"
    try:
        html = fetch(url, cache_dir)
    except Exception as e:
        log(f"  WARN: failed to fetch {url}: {e}")
        return None
    polls, elections = extract_state_page(html)
    polls = dedupe(polls, lambda p: (p["institute"], p["date"], tuple(sorted(p["results"].items()))))
    elections = dedupe(elections, lambda e: e["date"])
    polls.sort(key=lambda p: p["date"])
    elections.sort(key=lambda e: e["date"])
    log(f"  {name}: {len(polls)} polls, {len(elections)} elections")
    return {
        "key": slug,
        "name": name,
        "level": "state",
        "source": url,
        "polls": polls,
        "elections": elections,
    }


def region_summary(region: dict) -> dict:
    parties = {}
    for p in region["polls"]:
        for k in p["results"]:
            parties[k] = parties.get(k, 0) + 1
    return {
        "key": region["key"],
        "name": region["name"],
        "level": region["level"],
        "polls": len(region["polls"]),
        "institutes": sorted({p["institute"] for p in region["polls"]}),
        "parties": sorted(parties, key=parties.get, reverse=True),
        "first_poll": region["polls"][0]["date"] if region["polls"] else None,
        "last_poll": region["polls"][-1]["date"] if region["polls"] else None,
        "last_election": region["elections"][-1]["date"] if region["elections"] else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output data directory")
    ap.add_argument("--cache", type=Path, default=None, help="HTML cache dir (dev only)")
    ap.add_argument("--regions", nargs="*", default=None,
                    help="subset of region keys (default: all; 'bund' = federal)")
    args = ap.parse_args()

    def log(msg):
        print(msg, flush=True)

    wanted = set(args.regions) if args.regions else None
    regions = []

    if wanted is None or "bund" in wanted:
        log("Scraping federal institutes…")
        regions.append(scrape_federal(args.cache, log))

    log("Scraping states…")
    for slug, name in STATES.items():
        if wanted is not None and slug not in wanted:
            continue
        r = scrape_state(slug, name, args.cache, log)
        if r:
            regions.append(r)

    out_dir = args.out / "regions"
    out_dir.mkdir(parents=True, exist_ok=True)
    scraped_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    index = {"scraped_at": scraped_at, "regions": []}
    # Partial runs (--regions) keep the untouched regions' index entries.
    index_file = args.out / "index.json"
    if wanted is not None and index_file.exists():
        scraped_keys = {r["key"] for r in regions}
        old = json.loads(index_file.read_text(encoding="utf-8"))
        index["regions"] = [r for r in old.get("regions", []) if r["key"] not in scraped_keys]
    for region in regions:
        region["scraped_at"] = scraped_at
        (out_dir / f"{region['key']}.json").write_text(
            json.dumps(region, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        index["regions"].append(region_summary(region))

    # Keep index ordering stable: federal first, then states alphabetically.
    index["regions"].sort(key=lambda r: (r["level"] != "federal", r["name"]))
    index_file.write_text(
        json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"Wrote {len(regions)} region files to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
