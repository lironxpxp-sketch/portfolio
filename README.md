# lironsofer.online

Static site: `index.html` is the homepage, each project lives in `projects/<name>/`.

## 1. Publish on GitHub Pages

1. On github.com, click **New repository**. Name it `portfolio`, set it to **Public**, click **Create repository**.
2. On the new repo page, click **uploading an existing file**. Drag in everything from this folder (including the `projects`, `assets`, `worker` and `tools` folders, plus the `CNAME` and `.nojekyll` files), then click **Commit changes**.
3. Go to **Settings → Pages**. Set Source to **Deploy from a branch**, Branch **main**, folder **/ (root)**. Save.
4. Under **Custom domain**, check it says `lironsofer.online` (the `CNAME` file sets it).

## 2. Point your GoDaddy domain at it

GoDaddy: **My Products → lironsofer.online → DNS**.

- Delete existing **A** records for `@` (and any "Parked" record).
- Add four **A** records, Name `@`, Value:
  `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
- Edit (or add) a **CNAME** record, Name `www`, Value `<your-github-username>.github.io`

Wait up to a few hours, then in GitHub **Settings → Pages** tick **Enforce HTTPS**.

## 3. Turn on the AI features (Creative Studio, Pre-Call Brief)

Without this step the site still works; those two projects run in demo/template mode.

**a. Get an API key**
1. Sign up at **console.anthropic.com**, add a payment method.
2. **Settings → Limits**: set a monthly spend limit (e.g. $10). This is your hard cap.
3. **API Keys → Create Key**. Copy it (starts with `sk-ant-`).

**b. Create the Worker (free)**
1. Sign up at **dash.cloudflare.com**.
2. **Workers & Pages → Create → Create Worker**. Name it `liron-ai`, click **Deploy**.
3. Click **Edit code**, delete what's there, paste the contents of `worker/worker.js`, click **Deploy**.
4. Back on the Worker page: **Settings → Variables and Secrets → Add**. Type **Secret**, name `ANTHROPIC_API_KEY`, value = your key. Save.
5. Copy the Worker's address, e.g. `https://liron-ai.yourname.workers.dev`.

**c. Connect the site**
1. In GitHub, open `assets/claude-shim.js`, click the pencil icon.
2. Change `var AI_ENDPOINT = "";` to `var AI_ENDPOINT = "https://liron-ai.yourname.workers.dev";`
3. **Commit changes**. Within a minute, Creative Studio shows "Claude connected".

Guardrails built in: only your domain can call the Worker, each visitor gets 40 AI calls per 10 minutes, and prompts and answers are size-capped. The spend limit from step a.2 caps your bill.

### Which AI does what (automatic)

The Worker picks the AI for each job and skips any that isn't connected:

| Job | Order tried |
|---|---|
| Creative Studio: reading the brand's website | Claude → GPT → Gemini |
| Creative Studio: concepts, tone and ad copy | GPT → Claude → Gemini |
| Creative Studio: finished ad images | Nano Banana (Gemini) → OpenAI image model |
| Web research in the other tools | Gemini → GPT → Claude |
| Other writing | Claude → GPT → Gemini |

If one fails, the next one answers. To change the order, add a **Text** variable `ROUTES`, e.g. `{"copy":["openai","claude"]}`.

### Optional: connect GPT (OpenAI)

1. At **platform.openai.com** sign in, add billing credit, and set a monthly limit under **Settings → Limits**.
2. **API keys → Create new secret key**. Copy it (starts with `sk-`).
3. Cloudflare → your Worker → **Settings → Variables and Secrets → Add**: Type **Secret**, name `OPENAI_API_KEY`, value = the key. Deploy.

### Optional: connect Gemini (Google): research and Nano Banana images

1. At **aistudio.google.com** sign in and click **Get API key → Create API key**.
2. Cloudflare → your Worker → **Settings → Variables and Secrets → Add**: Type **Secret**, name `GEMINI_API_KEY`, value = the key. Deploy.

### Optional: real email finding in Reachlist (Hunter.io)

1. Sign up at **hunter.io** (free: 50 found emails a month; a credit is used only when an email is found).
2. **API → API key**, copy it.
3. Cloudflare → your Worker → **Settings → Variables and Secrets → Add**: Type **Secret**, name `HUNTER_API_KEY`. Deploy.

### Optional: "Sign in with Google" in Reachlist

1. **console.cloud.google.com** → create a project (e.g. "Reachlist").
2. **APIs & Services → OAuth consent screen**: User type **External**, app name "Reachlist", your email as support and developer contact. Scopes: just the defaults (email, profile, openid). Save.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**: Type **Web application**. Under **Authorized JavaScript origins** add `https://lironsofer.online` and `https://www.lironsofer.online`. Create, then copy the **Client ID** (ends in `.apps.googleusercontent.com`).
4. Cloudflare → your Worker → **Settings → Variables and Secrets → Add**: Type **Text**, name `GOOGLE_CLIENT_ID`, value = the Client ID. Deploy.
5. Publish the consent screen (**OAuth consent screen → Publish app**) so anyone can sign in. Sign-in with name and email doesn't need Google's review.

Sending straight from Gmail (instead of opening a draft) needs the Gmail API enabled and the `gmail.send` scope, which Google reviews before the public can use it (about 2–4 weeks). Until then it works for you and up to 100 test users you add on the consent screen. To turn it on, add a **Text** variable `GMAIL_SEND` = `on`.

## Updating projects

Master copies for the site live in `sources/`: Ad Performance Copilot (`ad-copilot.html`, tests: `node sources/ad-copilot.test.js`), Creative Studio, Market Research Agent and Reachlist. Build a project page with `python3 tools/prepare_project.py sources/<file>.html <slug>`. The other projects come from their Claude artifacts.

If `worker/worker.js` changes, paste the new version into the Cloudflare Worker again (Edit code → paste → Deploy).


Projects are copies of the Claude artifacts. After you change one in Claude, ask Claude to "refresh the site": it re-downloads each artifact, runs `tools/prepare_project.py` on it, and pushes the result.

## Visit stats and personalised links

Visits are counted with GoatCounter (free, no cookies) at **lironsofer.goatcounter.com**. Sign up at goatcounter.com with the code `lironsofer` to see the dashboard.

Send a company its own link: `https://lironsofer.online/?for=wix` (use dashes for spaces: `?for=check-point`). The page greets "Hi Wix team 👋", the email button gets the subject "Hi Liron (from Wix)", and the open shows up in GoatCounter as `for/wix`. Contact clicks show up as `contact/...`.
