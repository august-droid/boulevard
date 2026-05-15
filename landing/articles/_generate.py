"""
Article + pillar page generator for /articles/*.

Run once to produce static HTML files for every article in ARTICLES and
every pillar in PILLARS.

Article dict fields:
  slug         URL path segment (matches sitemap.xml)
  title        h1 + page title (no em dashes)
  title_html   title with <em> for italic-gold accent
  meta_title   browser tab / SERP title (brand suffix appended)
  meta_desc    meta name=description; also og:description
  eyebrow      uppercase line above the H1
  deck         lede paragraph below H1 (AEO direct answer, < 80 words)
  date         ISO date string for schema.org datePublished
  updated      ISO date string for dateModified
  read_min     read time in minutes (estimate)
  author       AUTHORS key — drives byline + author schema
  pillar       slug of the pillar that owns this article ("" for the
               pillar itself or stand-alone pieces)
  body         full HTML body fragment (sections, tables, lists, etc.)
  faqs         list of (question, answer) tuples. Rendered as <details>
               + FAQPage JSON-LD
  related      list of slugs to cross-link in the footer
  schema_type  optional: override schema.org Article subtype
               ("Article" | "TechArticle" | "NewsArticle"). Defaults to
               "Article".

Pillar dict fields (defined in PILLARS):
  slug         URL path segment (e.g. "ai-music")
  title        pillar's H1
  title_html   with <em> accents
  meta_title   SERP title
  meta_desc    meta description
  eyebrow      uppercase line above H1
  deck         lede paragraph
  subtopics    list of slugs whose articles belong to this pillar
  body         pillar's own original body content
  faqs         list of (q, a) tuples
"""

import json
import os
import re

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

SITE = "https://boulevardai.app"
ORG_ID = f"{SITE}/#organization"
WEBSITE_ID = f"{SITE}/#website"


# ----------------------------------------------------------------------------
# Schema rendering
# ----------------------------------------------------------------------------

def _strip_tags(s):
    return re.sub(r"<[^>]+>", "", s)


def render_site_context():
    """Organization + WebSite nodes, identical on every article/pillar page.
    Gives stable @id anchors that the Article/WebPage/FAQ/Breadcrumb nodes
    reference, so search and answer engines resolve one connected entity."""
    return json.dumps(
        {
            "@context": "https://schema.org",
            "@graph": [
                {
                    "@type": "Organization",
                    "@id": ORG_ID,
                    "name": "Boulevard",
                    "url": f"{SITE}/",
                    "logo": {
                        "@type": "ImageObject",
                        "@id": f"{SITE}/#logo",
                        "url": f"{SITE}/icons/android-chrome-512x512.png",
                        "contentUrl": f"{SITE}/icons/android-chrome-512x512.png",
                        "width": 512,
                        "height": 512,
                        "caption": "Boulevard",
                    },
                    "image": {"@id": f"{SITE}/#logo"},
                    "description": "Boulevard is the AI alternative to Spotify. An AI music app that generates songs tuned to how you feel.",
                    "slogan": "AI music, made for you.",
                    "email": "august@magnamarketing.io",
                    "foundingDate": "2026",
                    "sameAs": [],
                },
                {
                    "@type": "WebSite",
                    "@id": WEBSITE_ID,
                    "name": "Boulevard",
                    "url": f"{SITE}/",
                    "description": "Boulevard is the AI alternative to Spotify. Tell it how you feel, get an AI-generated song in seconds.",
                    "publisher": {"@id": ORG_ID},
                    "inLanguage": "en-US",
                },
            ],
        },
        ensure_ascii=False,
    )


def render_faq_schema(faqs, page_id=None):
    data = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "inLanguage": "en-US",
        "mainEntity": [
            {
                "@type": "Question",
                "name": q,
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": re.sub(r"\s+", " ", _strip_tags(a)).strip(),
                },
            }
            for q, a in faqs
        ],
    }
    if page_id:
        data["isPartOf"] = {"@id": page_id}
    return json.dumps(data, ensure_ascii=False)


def render_breadcrumb_schema(article, pillars):
    """Breadcrumb: Home > Articles > [Pillar?] > Article."""
    items = [
        {"@type": "ListItem", "position": 1, "name": "Boulevard", "item": "https://boulevardai.app/"},
        {"@type": "ListItem", "position": 2, "name": "Articles", "item": "https://boulevardai.app/articles"},
    ]
    pos = 3
    if article.get("pillar") and article["pillar"] in pillars:
        p = pillars[article["pillar"]]
        items.append({
            "@type": "ListItem",
            "position": pos,
            "name": p["title"],
            "item": f"https://boulevardai.app/articles/{p['slug']}",
        })
        pos += 1
    items.append({
        "@type": "ListItem",
        "position": pos,
        "name": article["title"],
        "item": f"https://boulevardai.app/articles/{article['slug']}",
    })
    return json.dumps(
        {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "@id": f"{SITE}/articles/{article['slug']}#breadcrumb",
            "itemListElement": items,
        },
        ensure_ascii=False,
    )


def render_article_schema(article, authors, pillars):
    author = authors.get(article.get("author", "august"), authors["august"])
    slug = article["slug"]
    page_url = f"{SITE}/articles/{slug}"
    author_schema = {
        "@type": "Person",
        "@id": f"{SITE}{author['url']}#person",
        "name": author["name"],
        "url": f"{SITE}{author['url']}",
        "jobTitle": author.get("job_title", ""),
        "description": author.get("bio", ""),
    }
    schema_type = article.get("schema_type", "Article")
    word_count = len(_strip_tags(article["body"]).split())
    pillar_label = (
        pillars[article["pillar"]]["title"]
        if article.get("pillar") in pillars
        else "Articles"
    )
    is_part_of = [{"@id": WEBSITE_ID}]
    if article.get("pillar") and article["pillar"] in pillars:
        p = pillars[article["pillar"]]
        is_part_of.append({
            "@type": "WebPage",
            "@id": f"{SITE}/articles/{p['slug']}#webpage",
            "name": p["title"],
        })
    return json.dumps(
        {
            "@context": "https://schema.org",
            "@type": schema_type,
            "@id": f"{page_url}#article",
            "headline": article["title"],
            "description": article["meta_desc"],
            "image": {
                "@type": "ImageObject",
                "url": f"{SITE}/icons/og-image.png",
                "width": 1200,
                "height": 630,
            },
            "datePublished": article["date"],
            "dateModified": article.get("updated", article["date"]),
            "author": author_schema,
            "publisher": {"@id": ORG_ID},
            "mainEntityOfPage": {"@type": "WebPage", "@id": page_url},
            "breadcrumb": {"@id": f"{page_url}#breadcrumb"},
            "articleSection": pillar_label,
            "inLanguage": "en-US",
            "wordCount": word_count,
            "keywords": article.get("keywords", "AI music, Boulevard, Spotify alternative"),
            "isPartOf": is_part_of,
            "speakable": {
                "@type": "SpeakableSpecification",
                "cssSelector": [".article-deck", ".quick"],
            },
        },
        ensure_ascii=False,
    )


def render_pillar_schema(pillar, articles):
    by_slug = {a["slug"]: a for a in articles}
    page_url = f"{SITE}/articles/{pillar['slug']}"
    item_list = [
        {
            "@type": "ListItem",
            "position": i + 1,
            "url": f"{SITE}/articles/{s}",
            "name": by_slug[s]["title"] if s in by_slug else s,
        }
        for i, s in enumerate(pillar["subtopics"])
        if s in by_slug
    ]
    updated = pillar.get("updated", "2026-05-15")
    return json.dumps(
        {
            "@context": "https://schema.org",
            "@type": "WebPage",
            "@id": f"{page_url}#webpage",
            "name": pillar["title"],
            "description": pillar["meta_desc"],
            "url": page_url,
            "inLanguage": "en-US",
            "isPartOf": {"@id": WEBSITE_ID},
            "publisher": {"@id": ORG_ID},
            "datePublished": "2026-05-13",
            "dateModified": updated,
            "primaryImageOfPage": {
                "@type": "ImageObject",
                "url": f"{SITE}/icons/og-image.png",
                "width": 1200,
                "height": 630,
            },
            "breadcrumb": {"@id": f"{page_url}#breadcrumb"},
            "speakable": {
                "@type": "SpeakableSpecification",
                "cssSelector": [".article-deck", ".quick"],
            },
            "mainEntity": {
                "@type": "ItemList",
                "itemListElement": item_list,
            },
        },
        ensure_ascii=False,
    )


# ----------------------------------------------------------------------------
# HTML templates
# ----------------------------------------------------------------------------

HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>{meta_title}</title>
  <meta name="description" content="{meta_desc}" />
  <link rel="canonical" href="https://boulevardai.app/articles/{slug}" />
  <meta name="theme-color" content="#0a0a0c" />
  <meta name="color-scheme" content="dark" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <meta name="author" content="{author_name}" />
  <meta name="geo.region" content="US" />

  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Boulevard" />
  <meta property="og:title" content="{meta_title}" />
  <meta property="og:description" content="{meta_desc}" />
  <meta property="og:url" content="https://boulevardai.app/articles/{slug}" />
  <meta property="og:image" content="https://boulevardai.app/icons/og-image.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:locale" content="en_US" />
  <meta property="article:published_time" content="{date}" />
  <meta property="article:modified_time" content="{updated}" />
  <meta property="article:author" content="{author_name}" />
  <meta property="article:section" content="{pillar_label}" />
  <meta property="article:publisher" content="https://boulevardai.app/" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{meta_title}" />
  <meta name="twitter:description" content="{meta_desc}" />
  <meta name="twitter:image" content="https://boulevardai.app/icons/og-image.png" />
  <meta name="twitter:label1" content="Written by" />
  <meta name="twitter:data1" content="{author_name}" />
  <meta name="twitter:label2" content="Reading time" />
  <meta name="twitter:data2" content="{read_min} min" />

  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32x32.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;1,9..144,500;1,9..144,600&family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/styles.css?v=2026-05-13j" />

  <script type="application/ld+json">{site_context}</script>
  <script type="application/ld+json">{article_schema}</script>
  <script type="application/ld+json">{faq_schema}</script>
  <script type="application/ld+json">{breadcrumb_schema}</script>
</head>
<body class="article-page">

<header class="nav">
  <div class="nav-inner">
    <a class="brand" href="/">
      <span class="brand-mark">B</span>
      <span class="brand-word">Boulevard</span>
    </a>
    <nav class="nav-menu">
      <a href="/#features">Features</a>
      <a href="/#listen">Listen</a>
      <a href="/#compare">vs. Spotify</a>
      <a href="/articles">Articles</a>
      <a href="/#faq">FAQ</a>
      <a href="/#download" class="nav-cta">Get the app</a>
    </nav>
  </div>
</header>

<main>
  <div class="container">
    <p class="crumb">{breadcrumb_html}</p>

    <header class="article-head">
      <p class="article-eyebrow">{eyebrow}</p>
      <h1 class="article-title">{title_html}</h1>
      <p class="article-deck">{deck}</p>
      <div class="article-meta">
        <span>By <a href="{author_url}"><strong>{author_name}</strong></a>, <em>{author_job}</em></span>
        <span>Published <time datetime="{date}">{pub_human}</time></span>
        <span>Updated <time datetime="{updated}">{upd_human}</time></span>
        <span>{read_min} min read</span>
      </div>
    </header>

    <article class="article-body">
{body}

      <section class="article-cta">
        <h3>Skip the Spotify subscription. <em>Try the AI alternative.</em></h3>
        <p>Boulevard is the AI music app. Free to start. iOS and Android.</p>
        <div class="cta-row cta-row-center">
          <a class="badge" href="/#download" aria-label="Get it on Google Play">
            <svg viewBox="0 0 180 54" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect width="180" height="54" rx="8" fill="#000"/>
              <rect x="0.5" y="0.5" width="179" height="53" rx="7.5" fill="none" stroke="#A6A6A6" stroke-width="1"/>
              <text x="50" y="22" fill="#fff" font-family="Roboto, Arial, sans-serif" font-size="9" font-weight="400">GET IT ON</text>
              <text x="50" y="40" fill="#fff" font-family="Roboto, Arial, sans-serif" font-size="19" font-weight="500" letter-spacing="-0.5">Google Play</text>
            </svg>
          </a>
          <a class="badge" href="/#download" aria-label="Download on the App Store">
            <svg viewBox="0 0 180 54" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect width="180" height="54" rx="8" fill="#000"/>
              <rect x="0.5" y="0.5" width="179" height="53" rx="7.5" fill="none" stroke="#A6A6A6" stroke-width="1"/>
              <text x="50" y="22" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="9" font-weight="400">Download on the</text>
              <text x="50" y="40" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="500" letter-spacing="-0.5">App Store</text>
            </svg>
          </a>
        </div>
      </section>

      <h2 id="faq">Frequently asked questions</h2>
      <div class="faq-list">
{faq_html}
      </div>

      <aside class="author-bio">
        <span class="author-mark" aria-hidden="true"></span>
        <div class="author-bio-body">
          <p class="author-bio-name"><strong>About {author_name}</strong> · <em>{author_job}</em></p>
          <p class="author-bio-text">{author_bio}</p>
        </div>
      </aside>
    </article>

    <section class="article-related">
      <h3>Keep reading</h3>
      <div class="articles-grid">
{related_html}
      </div>
    </section>
  </div>
</main>

<footer class="footer">
  <div class="container footer-inner">
    <div class="footer-brand">
      <a class="brand" href="/">
        <span class="brand-mark">B</span>
        <span class="brand-word">Boulevard</span>
      </a>
      <p class="footer-tag">AI music, made for you.</p>
    </div>
    <div class="footer-cols">
      <div class="footer-col">
        <h4>Product</h4>
        <a href="/#features">Features</a>
        <a href="/#listen">Listen</a>
        <a href="/#how">How it works</a>
        <a href="/#faq">FAQ</a>
      </div>
      <div class="footer-col">
        <h4>Read</h4>
        <a href="/articles">All articles</a>
        <a href="/articles/ai-music">AI music guide</a>
        <a href="/articles/spotify-alternative">Spotify alternative</a>
      </div>
      <div class="footer-col">
        <h4>Legal</h4>
        <a href="/privacy-policy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="/delete-account">Delete account</a>
      </div>
    </div>
  </div>
  <div class="container footer-bottom">
    <span>&copy; 2026 Boulevard. boulevardai.app</span>
    <span>Made in Copenhagen.</span>
  </div>
</footer>

</body>
</html>
"""


PILLAR_HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>{meta_title}</title>
  <meta name="description" content="{meta_desc}" />
  <link rel="canonical" href="https://boulevardai.app/articles/{slug}" />
  <meta name="theme-color" content="#0a0a0c" />
  <meta name="color-scheme" content="dark" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <meta name="author" content="Boulevard Editorial" />
  <meta name="geo.region" content="US" />

  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Boulevard" />
  <meta property="og:title" content="{meta_title}" />
  <meta property="og:description" content="{meta_desc}" />
  <meta property="og:url" content="https://boulevardai.app/articles/{slug}" />
  <meta property="og:image" content="https://boulevardai.app/icons/og-image.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:locale" content="en_US" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{meta_title}" />
  <meta name="twitter:description" content="{meta_desc}" />
  <meta name="twitter:image" content="https://boulevardai.app/icons/og-image.png" />

  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32x32.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;1,9..144,500;1,9..144,600&family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/styles.css?v=2026-05-13j" />

  <script type="application/ld+json">{site_context}</script>
  <script type="application/ld+json">{pillar_schema}</script>
  <script type="application/ld+json">{faq_schema}</script>
  <script type="application/ld+json">{breadcrumb_schema}</script>
</head>
<body class="article-page pillar-page">

<header class="nav">
  <div class="nav-inner">
    <a class="brand" href="/">
      <span class="brand-mark">B</span>
      <span class="brand-word">Boulevard</span>
    </a>
    <nav class="nav-menu">
      <a href="/#features">Features</a>
      <a href="/#listen">Listen</a>
      <a href="/#compare">vs. Spotify</a>
      <a href="/articles">Articles</a>
      <a href="/#faq">FAQ</a>
      <a href="/#download" class="nav-cta">Get the app</a>
    </nav>
  </div>
</header>

<main>
  <div class="container">
    <p class="crumb"><a href="/">Boulevard</a><span class="sep">/</span><a href="/articles">Articles</a><span class="sep">/</span><span>{crumb_title}</span></p>

    <header class="article-head">
      <p class="article-eyebrow">{eyebrow}</p>
      <h1 class="article-title">{title_html}</h1>
      <p class="article-deck">{deck}</p>
      <div class="article-meta">
        <span>By <strong>Boulevard Editorial</strong></span>
        <span>Updated <time datetime="{updated}">{upd_human}</time></span>
        <span>{subtopic_count} articles in this guide</span>
      </div>
    </header>

    <article class="article-body">
{body}

      <h2 id="all-articles">Every article in this guide</h2>
      <div class="pillar-grid">
{subtopics_html}
      </div>

      <section class="article-cta">
        <h3>Skip the reading. <em>Just try the app.</em></h3>
        <p>Boulevard is the AI music app. Free to start. iOS and Android.</p>
        <div class="cta-row cta-row-center">
          <a class="badge" href="/#download" aria-label="Get it on Google Play">
            <svg viewBox="0 0 180 54" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect width="180" height="54" rx="8" fill="#000"/>
              <rect x="0.5" y="0.5" width="179" height="53" rx="7.5" fill="none" stroke="#A6A6A6" stroke-width="1"/>
              <text x="50" y="22" fill="#fff" font-family="Roboto, Arial, sans-serif" font-size="9" font-weight="400">GET IT ON</text>
              <text x="50" y="40" fill="#fff" font-family="Roboto, Arial, sans-serif" font-size="19" font-weight="500" letter-spacing="-0.5">Google Play</text>
            </svg>
          </a>
          <a class="badge" href="/#download" aria-label="Download on the App Store">
            <svg viewBox="0 0 180 54" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect width="180" height="54" rx="8" fill="#000"/>
              <rect x="0.5" y="0.5" width="179" height="53" rx="7.5" fill="none" stroke="#A6A6A6" stroke-width="1"/>
              <text x="50" y="22" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="9" font-weight="400">Download on the</text>
              <text x="50" y="40" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="500" letter-spacing="-0.5">App Store</text>
            </svg>
          </a>
        </div>
      </section>

      <h2 id="faq">Frequently asked questions</h2>
      <div class="faq-list">
{faq_html}
      </div>
    </article>
  </div>
</main>

<footer class="footer">
  <div class="container footer-inner">
    <div class="footer-brand">
      <a class="brand" href="/">
        <span class="brand-mark">B</span>
        <span class="brand-word">Boulevard</span>
      </a>
      <p class="footer-tag">AI music, made for you.</p>
    </div>
    <div class="footer-cols">
      <div class="footer-col">
        <h4>Product</h4>
        <a href="/#features">Features</a>
        <a href="/#listen">Listen</a>
        <a href="/#how">How it works</a>
        <a href="/#faq">FAQ</a>
      </div>
      <div class="footer-col">
        <h4>Read</h4>
        <a href="/articles">All articles</a>
        <a href="/articles/ai-music">AI music guide</a>
        <a href="/articles/spotify-alternative">Spotify alternative</a>
      </div>
      <div class="footer-col">
        <h4>Legal</h4>
        <a href="/privacy-policy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="/delete-account">Delete account</a>
      </div>
    </div>
  </div>
  <div class="container footer-bottom">
    <span>&copy; 2026 Boulevard. boulevardai.app</span>
    <span>Made in Copenhagen.</span>
  </div>
</footer>

</body>
</html>
"""


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def human_date(iso):
    import datetime
    d = datetime.date.fromisoformat(iso)
    if os.uname().sysname == "Windows":
        return d.strftime("%B %#d, %Y")
    return d.strftime("%B %-d, %Y")


def render_faqs(faqs):
    out = []
    for q, a in faqs:
        out.append(f"        <details><summary>{q}</summary><div>{a}</div></details>")
    return "\n".join(out)


def render_related_cards(related_slugs, all_articles):
    by_slug = {a["slug"]: a for a in all_articles}
    out = []
    for s in related_slugs:
        a = by_slug.get(s)
        if not a:
            continue
        sub = a["deck"][:140].rstrip()
        if len(a["deck"]) > 140:
            sub += "…"
        out.append(
            f'        <a class="article-card" href="/articles/{a["slug"]}">\n'
            f'          <p class="article-tag">{a["eyebrow"]}</p>\n'
            f'          <h3>{a["title"]}</h3>\n'
            f'          <p class="article-sub">{sub}</p>\n'
            f'          <span class="article-link">Read article →</span>\n'
            f'        </a>'
        )
    return "\n".join(out)


def render_breadcrumb_html(article, pillars):
    parts = [
        '<a href="/">Boulevard</a>',
        '<a href="/articles">Articles</a>',
    ]
    if article.get("pillar") and article["pillar"] in pillars:
        p = pillars[article["pillar"]]
        parts.append(f'<a href="/articles/{p["slug"]}">{p["title"]}</a>')
    parts.append(f'<span>{article["title"]}</span>')
    sep = '<span class="sep">/</span>'
    return sep.join(parts)


def render_subtopic_cards(pillar, all_articles):
    by_slug = {a["slug"]: a for a in all_articles}
    out = []
    for s in pillar["subtopics"]:
        a = by_slug.get(s)
        if not a:
            continue
        sub = a["deck"][:160].rstrip()
        if len(a["deck"]) > 160:
            sub += "…"
        out.append(
            f'        <a class="article-card" href="/articles/{a["slug"]}">\n'
            f'          <p class="article-tag">{a["eyebrow"]}</p>\n'
            f'          <h3>{a["title"]}</h3>\n'
            f'          <p class="article-sub">{sub}</p>\n'
            f'          <span class="article-link">Read article →</span>\n'
            f'        </a>'
        )
    return "\n".join(out)


# ----------------------------------------------------------------------------
# Build functions
# ----------------------------------------------------------------------------

def build_article(article, all_articles, authors, pillars):
    author = authors.get(article.get("author", "august"), authors["august"])
    article_schema = render_article_schema(article, authors, pillars)
    faq_schema = render_faq_schema(article["faqs"], f"{SITE}/articles/{article['slug']}")
    breadcrumb_schema = render_breadcrumb_schema(article, pillars)
    site_context = render_site_context()
    faq_html = render_faqs(article["faqs"])
    related_html = render_related_cards(article["related"], all_articles)
    breadcrumb_html = render_breadcrumb_html(article, pillars)
    pillar_label = pillars[article["pillar"]]["title"] if article.get("pillar") in pillars else "Articles"
    html = HEAD.format(
        slug=article["slug"],
        meta_title=article["meta_title"],
        meta_desc=article["meta_desc"].replace('"', "&quot;"),
        eyebrow=article["eyebrow"],
        title_html=article["title_html"],
        crumb_title=article["title"],
        deck=article["deck"],
        date=article["date"],
        updated=article.get("updated", article["date"]),
        pub_human=human_date(article["date"]),
        upd_human=human_date(article.get("updated", article["date"])),
        read_min=article["read_min"],
        body=article["body"],
        faq_html=faq_html,
        article_schema=article_schema,
        faq_schema=faq_schema,
        breadcrumb_schema=breadcrumb_schema,
        site_context=site_context,
        breadcrumb_html=breadcrumb_html,
        related_html=related_html,
        author_name=author["name"],
        author_url=author["url"],
        author_job=author["job_title"],
        author_bio=author["bio"],
        pillar_label=pillar_label,
    )
    out_path = os.path.join(OUT_DIR, article["slug"] + ".html")
    with open(out_path, "w") as f:
        f.write(html)
    print(f"  article: {article['slug']}.html")


def build_pillar(pillar, all_articles):
    pillar_schema = render_pillar_schema(pillar, all_articles)
    faq_schema = render_faq_schema(pillar["faqs"], f"{SITE}/articles/{pillar['slug']}#webpage")
    site_context = render_site_context()
    # Breadcrumb for pillar (no pillar-of-pillar, just Home > Articles > Pillar)
    breadcrumb_schema = json.dumps({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "@id": f"{SITE}/articles/{pillar['slug']}#breadcrumb",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Boulevard", "item": "https://boulevardai.app/"},
            {"@type": "ListItem", "position": 2, "name": "Articles", "item": "https://boulevardai.app/articles"},
            {"@type": "ListItem", "position": 3, "name": pillar["title"], "item": f"https://boulevardai.app/articles/{pillar['slug']}"},
        ],
    }, ensure_ascii=False)
    faq_html = render_faqs(pillar["faqs"])
    subtopics_html = render_subtopic_cards(pillar, all_articles)
    subtopic_count = sum(1 for s in pillar["subtopics"] if any(a["slug"] == s for a in all_articles))
    html = PILLAR_HEAD.format(
        slug=pillar["slug"],
        meta_title=pillar["meta_title"],
        meta_desc=pillar["meta_desc"].replace('"', "&quot;"),
        eyebrow=pillar["eyebrow"],
        title_html=pillar["title_html"],
        crumb_title=pillar["title"],
        deck=pillar["deck"],
        updated=pillar.get("updated", "2026-05-13"),
        upd_human=human_date(pillar.get("updated", "2026-05-13")),
        body=pillar["body"],
        faq_html=faq_html,
        pillar_schema=pillar_schema,
        faq_schema=faq_schema,
        breadcrumb_schema=breadcrumb_schema,
        site_context=site_context,
        subtopics_html=subtopics_html,
        subtopic_count=subtopic_count,
    )
    out_path = os.path.join(OUT_DIR, pillar["slug"] + ".html")
    with open(out_path, "w") as f:
        f.write(html)
    print(f"  pillar:  {pillar['slug']}.html")


if __name__ == "__main__":
    from content import ARTICLES, AUTHORS, PILLARS
    print(f"Generating {len(ARTICLES)} articles and {len(PILLARS)} pillars…")
    for a in ARTICLES:
        build_article(a, ARTICLES, AUTHORS, PILLARS)
    for slug, p in PILLARS.items():
        build_pillar(p, ARTICLES)
    print("Done.")
