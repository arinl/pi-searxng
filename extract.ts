import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});

const DEFAULT_TIMEOUT = 30000;
const MAX_SIZE = 5 * 1024 * 1024;

export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  error?: string;
}

export async function fetchContent(url: string): Promise<ExtractedContent> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    
    if (!res.ok) {
      return { url, title: "", content: "", error: `HTTP ${res.status}` };
    }
    
    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_SIZE) {
      return { url, title: "", content: "", error: "Content too large" };
    }
    
    const html = await res.text();
    const { document } = parseHTML(html);
    const reader = new Readability(document);
    const article = reader.parse();
    
    if (!article) {
      return { url, title: "", content: "", error: "Could not extract content" };
    }
    
    return {
      url,
      title: article.title || url,
      content: turndown.turndown(article.content)
    };
  } catch (err) {
    return { 
      url, 
      title: "", 
      content: "", 
      error: err instanceof Error ? err.message : String(err) 
    };
  } finally {
    clearTimeout(timeout);
  }
}
