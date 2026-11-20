"""Indeed collector for the US office computer (Windows).

Reads the candidate list of the Indeed employer account in the "Chrome - Indeed Bot" window (already
signed in, started with --remote-debugging-port=9222) and posts what it sees to the bot:
POST <BOT_URL>/api/indeed/report. The bot decides what is new, posts the cards to the hiring chat,
sends the import Excel and raises the alerts. This script keeps no state and never clicks anything.

Run every 30 minutes by Windows Task Scheduler:  pythonw C:\\IndeedBot\\indeed_collector.py
Test by hand (no random wait, prints what it sends):  python C:\\IndeedBot\\indeed_collector.py now
Needs: python -m pip install playwright requests
Docs: docs/INDEED_APPLICANTS.md in the bot's project.
"""
import json
import os
import random
import sys
import time
import traceback
from datetime import datetime

import requests
from playwright.sync_api import sync_playwright

# ---- Settings: fill these two in ----
BOT_URL = "https://YOUR-BOT-DOMAIN"           # the bot's address (APP_URL), no slash at the end
COLLECTOR_KEY = "PASTE_INDEED_COLLECTOR_TOKEN"  # INDEED_COLLECTOR_TOKEN from the bot's .env

CANDIDATES_URL = "https://employers.indeed.com/candidates?statusName=All&id=0&tab=manage"
CHROME = "http://localhost:9222"
FOLDER = r"C:\IndeedBot"
LOG_FILE = os.path.join(FOLDER, "log.txt")
WANTED = {"FindRCPMatches", "FindEmployerJobs"}


def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def get(d, *path):
    for p in path:
        if not isinstance(d, dict):
            return None
        d = d.get(p)
    return d


def operation_names(request):
    try:
        data = json.loads(request.post_data or "")
    except (ValueError, TypeError):
        return []
    items = data if isinstance(data, list) else [data]
    return [x.get("operationName") for x in items if isinstance(x, dict)]


def read_indeed():
    """Returns (status, detail, json bodies). Status: ok, chrome_closed, logged_out, no_data, error."""
    captured = []

    def on_response(resp):
        if "graphql" in resp.url and WANTED & set(operation_names(resp.request)):
            captured.append(resp)

    try:
        with sync_playwright() as p:
            try:
                browser = p.chromium.connect_over_cdp(CHROME)
            except Exception as ex:
                return "chrome_closed", str(ex).splitlines()[0][:200], []
            context = browser.contexts[0]
            page = context.new_page()
            try:
                page.on("response", on_response)
                page.goto(CANDIDATES_URL, wait_until="domcontentloaded", timeout=60000)
                for _ in range(30):
                    page.wait_for_timeout(1000)
                    if any("FindRCPMatches" in operation_names(r.request) for r in captured):
                        break
                page.wait_for_timeout(random.randint(2000, 5000))
                url = page.url
                bodies = []
                for r in captured:
                    try:
                        body = r.json()
                    except Exception:
                        continue
                    bodies.extend(body if isinstance(body, list) else [body])
            finally:
                page.close()
    except Exception as ex:
        return "error", f"{type(ex).__name__}: {str(ex).splitlines()[0][:200]}", []

    if "login" in url or "/auth" in url or "secure.indeed.com" in url:
        return "logged_out", None, []
    return "ok", None, bodies


def job_titles(node, out):
    """Every employer job id → title found anywhere in Indeed's answers."""
    if isinstance(node, dict):
        job = node.get("employerJob")
        if isinstance(job, dict) and job.get("id") and get(job, "jobData", "title"):
            out[job["id"]] = job["jobData"]["title"]
        for v in node.values():
            job_titles(v, out)
    elif isinstance(node, list):
        for v in node:
            job_titles(v, out)
    return out


def applicants(bodies):
    titles = {}
    for b in bodies:
        job_titles(b, titles)
    found = []
    for b in bodies:
        for m in get(b, "data", "findRCPMatches", "matchConnection", "matches") or []:
            sub = (m or {}).get("candidateSubmission") or {}
            data = sub.get("data") or {}
            sid = data.get("submissionUuid") or sub.get("id")
            name = get(data, "profile", "name", "displayName")
            if not sid or not name:
                continue
            job_id = get(data, "job", "id") or get(data, "aggJob", "employerJob", "id")
            experience = []
            for e in (get(sub, "talentRepresentation", "experience") or [])[:2]:
                if isinstance(e, dict):
                    text = " — ".join(x for x in (e.get("title"), e.get("company")) if x)
                    if text:
                        experience.append(text)
            found.append({
                "id": sid,
                "name": name,
                "phone": get(data, "profile", "contact", "phoneNumber"),
                "location": get(data, "profile", "location", "location"),
                "job": titles.get(job_id),
                "applied_at": data.get("created"),
                "experience": experience,
            })
    return found


def send(report):
    for attempt in (1, 2):
        try:
            r = requests.post(f"{BOT_URL}/api/indeed/report", json=report,
                              headers={"Authorization": f"Bearer {COLLECTOR_KEY}"}, timeout=60)
            if r.ok:
                return r.json()
            log(f"Bot answered {r.status_code}: {r.text[:200]}")
            return None
        except requests.RequestException as ex:
            log(f"Bot not reachable (try {attempt}): {ex}")
            time.sleep(20)
    return None


def main():
    by_hand = len(sys.argv) > 1 and sys.argv[1] == "now"
    if not by_hand:
        time.sleep(random.randint(0, 120))  # not at the same minute every time
    status, detail, bodies = read_indeed()
    found = applicants(bodies) if status == "ok" else []
    if status == "ok" and not found:
        status, detail = "no_data", "no applicants in Indeed's answer"
    report = {"status": status, "detail": detail, "applicants": found}
    if by_hand:
        print(json.dumps({**report, "applicants": found[:2]}, indent=1, ensure_ascii=False)[:3000])
    answer = send(report)
    log(f"{status}: {len(found)} applicants seen" + (f", bot: {answer}" if answer else ", bot did not confirm"))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log("Unexpected error:\n" + traceback.format_exc())
