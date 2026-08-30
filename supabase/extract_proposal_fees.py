#!/usr/bin/env python3
"""
Extract the CONTRACTED PROPOSAL FEE for each 2026 project from the actual
proposal PDF in Dropbox.

WHY THIS EXISTS
The CRM's `amount` column was originally hand-typed in seed_db.py and mostly
reflected QuickBooks invoices (money already billed), NOT the proposal fee.
Verified mismatches: 26007 CRM $42,000 vs proposal $28,000; 26014 CRM $6,500 vs
proposal $13,000; 26011 CRM $20,000 vs proposal $24,800.

HOW PLAZA PROPOSALS ARE STRUCTURED
There is rarely a single "amount". Most carry a phased FEE SUMMARY TABLE:
    I.   INVESTIGATION PHASE            $ 4,900
    II.  CONSTRUCTION DOCUMENTS PHASE   $ 19,900
    III. BID ASSISTANCE PHASE           INCLUDED
    IV.  CONSTRUCTION ADMINISTRATION    HOURLY**
Others use a deposit/final split with an explicit TOTAL, or per-task pricing
(Task 1A / Task 1B), or a flat monthly rate.

RULES
- If an explicit TOTAL is present, trust it.
- Otherwise sum the fixed-dollar phases/tasks. INCLUDED and HOURLY contribute $0
  but are recorded so the UI can disclose them.
- Never invent a number. If no text layer exists (scanned PDF), report needs_ocr.

Run:  python3 extract_proposal_fees.py            # prints a report
      python3 extract_proposal_fees.py --json     # machine-readable
"""
import glob
import json
import os
import re
import sys

BASE = os.path.expanduser("~/Dropbox-Plaza&Associates/William Plaza/2026 PROJECTS")

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF required:  /usr/bin/python3 -m pip install --user pymupdf")

MONEY = re.compile(r"\$\s*([\d,]+(?:\.\d{2})?)")
# Lines that price a phase/task/deposit rather than quoting a rate or an example.
FEE_LINE = re.compile(
    r"(INVESTIGATION|CONSTRUCTION\s+DOCUMENT|BID\s+ASSISTANCE|BIDDING|CONSTRUCTION\s+ADMIN"
    r"|PERMIT|DESIGN|ENGINEERING|INSPECTION|RECERTIFICATION|SURVEY|Task\s*\d"
    r"|PHASE|DEPOSIT|FINAL\s+PAYMENT|LUMP\s*SUM|TOTAL|FEE\s+STRUCTURE|Pre-construction)",
    re.I,
)
# Task rows use an en-dash or em-dash, not a hyphen: "Task 1A – Engineering drawings".
# A plain [-] class silently misses them, which is why 26014 ($8,000 + $5,000) failed.
TASK_LINE = re.compile(r"^\s*Task\s*\d+[A-Z]?\s*[\u2013\u2014\-:]", re.I)
# Hourly-rate schedules and unit rates must NOT be summed into a contract value.
# NOTE: job titles are only rate indicators when they stand alone as a schedule row
# (e.g. "Principal Engineer ... $390/hr"). Requiring an accompanying rate word stops
# this from wrongly rejecting real fee rows like
# "Task 1A – Engineering drawings – Swimming pool   $8,000" (26014 regression).
RATE_HINT = re.compile(
    r"(per\s+hour|/\s*hour|hourly|per\s+visit|per\s+trip|per\s+opening"
    r"|\brate\b|\beach\b"
    r"|(?:principal|engineer|inspector|technician|draftsman|CAD|admin)[^\n]{0,20}"
    r"(?:per\s+hour|/\s*hour|hourly|\brate\b))",
    re.I,
)
# Contract boilerplate that happens to contain a dollar figure. These are NOT fees:
# e.g. "...or damages incurred by the Client resulting from a work stoppage ... $150".
# Without this guard a $150/$250 re-mobilisation clause gets summed into every total.
PROSE_CLAUSE = re.compile(
    r"(damages|incurred|resulting from|work\s*stoppage|stoppage|re-?mobiliz|penalt"
    r"|interest|late\s+fee|per\s+diem|retainer\s+applied|shall|liabilit|indemnif"
    r"|adherence|provide\s+certification)",
    re.I,
)


def money_in(text):
    return [float(m.replace(",", "")) for m in MONEY.findall(text)]


def parse(path):
    """Return a dict describing the fee structure found in one proposal PDF."""
    out = {
        "file": os.path.basename(path),
        "fee": None,
        "basis": None,
        "components": [],
        "flags": [],
    }
    try:
        doc = fitz.open(path)
        text = "\n".join(p.get_text() for p in doc)
    except Exception as e:  # pragma: no cover
        out["flags"].append(f"open_error:{e}")
        return out

    if len(text.strip()) < 200:
        out["flags"].append("needs_ocr")  # scanned image, no text layer
        return out

    lines = [l.strip() for l in text.split("\n")]

    # ---- 1) explicit TOTAL / "shall be paid the sum of $X" wins -----------
    # 26019 states "PA shall be paid the sum of $17,500 payable as follows:" and then
    # splits it 50/50 ($8,750 + $8,750). Summing the parts AND the sum double-counts,
    # so an explicit contract sum is authoritative.
    m = re.search(r"shall be paid the sum of\s*\$\s*([\d,]+(?:\.\d{2})?)", text, re.I)
    if m:
        out["fee"] = float(m.group(1).replace(",", ""))
        out["basis"] = "stated contract sum"
        out["components"].append({"label": "Stated contract sum", "amount": out["fee"]})
        return out

    for i, l in enumerate(lines):
        if re.search(r"\bTOTAL\b", l, re.I) and not RATE_HINT.search(l):
            vals = money_in(l)
            if not vals:  # amount often sits on the next non-blank line
                for j in range(i + 1, min(i + 4, len(lines))):
                    if lines[j]:
                        vals = money_in(lines[j])
                        if vals:
                            break
            if vals:
                out["fee"] = max(vals)
                out["basis"] = "explicit TOTAL"
                out["components"].append({"label": "TOTAL", "amount": max(vals)})
                return out

    # ---- 2) phased fee summary table --------------------------------------
    start = text.find("FEE SUMMARY")
    region = lines
    if start >= 0:
        upto = text[start : start + 900]
        region = [l.strip() for l in upto.split("\n")]
        out["basis"] = "FEE SUMMARY TABLE"

    comps, i = [], 0
    while i < len(region):
        l = region[i]
        if (
            l
            and (FEE_LINE.search(l) or TASK_LINE.search(l))
            and not RATE_HINT.search(l)
            and not PROSE_CLAUSE.search(l)
            and len(l) <= 80          # fee-table rows are short; prose lines are long
        ):
            label = re.sub(r"\s+", " ", l)[:60]
            vals = money_in(l)
            note = None
            if not vals:
                for j in range(i + 1, min(i + 4, len(region))):
                    nxt = region[j]
                    if not nxt:
                        continue
                    if re.match(r"^(INCLUDED|HOURLY|TBD|N/?A)", nxt, re.I):
                        note = nxt.split("*")[0].strip().upper()
                        break
                    if PROSE_CLAUSE.search(nxt) or len(nxt) > 80:
                        break
                    v = money_in(nxt)
                    if v:
                        vals = v
                        break
                    if FEE_LINE.search(nxt):
                        break
            if vals:
                comps.append({"label": label, "amount": vals[0]})
            elif note:
                comps.append({"label": label, "amount": 0, "note": note})
                out["flags"].append(note.lower())
        i += 1

    # de-dupe identical label/amount pairs
    seen, uniq = set(), []
    for c in comps:
        k = (c["label"], c["amount"])
        if k not in seen:
            seen.add(k)
            uniq.append(c)

    # A single PDF can contain MORE THAN ONE fee table (e.g. 26008 bundles a second
    # scope, so "I. INVESTIGATION PHASE" appears twice with different amounts).
    # Summing across both inflates the contract value, so keep only the FIRST table:
    # cut at the point where a phase label repeats.
    first_table, labels_seen = [], set()
    for c in uniq:
        key = re.sub(r"[^a-z]", "", c["label"].lower())[:22]
        if key in labels_seen:
            out["flags"].append("multiple_fee_tables")
            break
        labels_seen.add(key)
        first_table.append(c)
    uniq = first_table

    priced = [c for c in uniq if c["amount"] > 0]
    if priced:
        out["components"] = uniq
        summed = round(sum(c["amount"] for c in priced), 2)

        # Some fee tables list SUB-LINE ITEMS under a phase and then a phase subtotal,
        # plus a grand total on its own line (26013-1: Streets $40,000 + Sidewalks
        # $15,000 + Drainage $17,400 = subtotal $62,400, then grand total $72,400).
        # Naively summing the rows double-counts. If a bare dollar figure in the fee
        # region equals or exceeds the naive sum, trust that grand total instead.
        bare = []
        for l in region:
            s = l.strip()
            if re.fullmatch(r"\$\s*[\d,]+(?:\.\d{2})?", s):
                bare.append(float(re.sub(r"[^\d.]", "", s)))
        grand = [b for b in bare if b >= summed]
        if grand:
            # Take the LARGEST candidate: with nested subtotals the fee region contains
            # both a phase subtotal and the grand total (26013-1 shows $62,400 subtotal
            # then $72,400 grand total). min() would wrongly lock onto the subtotal.
            g = max(grand)
            if g > summed:               # a true grand total above the row sum
                out["fee"] = g
                out["basis"] = "grand total in fee table"
                out["flags"].append("nested_subtotals")
                return out
            # g == summed: rows already reconcile, keep the sum

        out["fee"] = summed
        out["basis"] = out["basis"] or "sum of priced phases/tasks"
        return out

    # ---- 3) last resort: a single dollar figure in the document ------------
    allm = [v for v in money_in(text) if v >= 500]
    if len(set(allm)) == 1:
        out["fee"] = allm[0]
        out["basis"] = "single figure in document"
        return out

    out["flags"].append("no_fee_parsed")
    if allm:
        out["components"] = [{"label": "unresolved figures", "amount": v} for v in sorted(set(allm))[:8]]
    return out


def pick_proposal(folder, pn):
    """Choose the most likely proposal PDF; prefer text-layer originals."""
    pdfs = glob.glob(folder + "/**/*.pdf", recursive=True)
    cands = []
    for f in pdfs:
        n = os.path.basename(f)
        if re.search(r"(FR|SI|SM)-\d|Permit|Notice_of_Comm|Bidsheet|SUPERSEDED|REMOVED", n):
            continue
        if re.search(r"proposal", n, re.I) or n.startswith(pn):
            cands.append(f)
    if not cands:
        return None
    # de-prioritise SIGNED scans (usually no text layer) and revisions
    cands.sort(key=lambda f: ("SIGNED" in f.upper(), "REV" in f.upper(), -len(f)))
    return cands[0]


def main():
    rows = []
    for folder in sorted(glob.glob(BASE + "/26*")):
        if not os.path.isdir(folder):
            continue
        name = os.path.basename(folder)
        pn = name.split(" ")[0]
        pdf = pick_proposal(folder, pn)
        if not pdf:
            rows.append({"project_no": pn, "folder": name, "fee": None,
                         "flags": ["no_proposal_pdf"], "components": [], "file": None,
                         "basis": None})
            continue
        r = parse(pdf)
        r["project_no"] = pn
        r["folder"] = name
        rows.append(r)

    if "--json" in sys.argv:
        print(json.dumps(rows, indent=2))
        return

    ok = [r for r in rows if r["fee"]]
    print(f"{len(rows)} project folders | {len(ok)} fees parsed\n")
    for r in rows:
        fee = f"${r['fee']:,.0f}" if r["fee"] else "—"
        flags = (" [" + ",".join(r["flags"]) + "]") if r["flags"] else ""
        print(f"{r['project_no']:<9} {fee:>11}  {str(r['basis'] or ''):<26}{flags}")
        for c in r["components"][:6]:
            note = f" ({c['note']})" if c.get("note") else ""
            print(f"              - {c['label'][:52]:<52} ${c['amount']:,.0f}{note}")
    print(f"\nTOTAL parsed contract value: ${sum(r['fee'] for r in ok):,.0f}")


if __name__ == "__main__":
    main()
