// Escaping text for Telegram HTML messages and for SVG/XML. Pure functions, used by the server and the Mini App.

/** Text for a Telegram message sent with parse_mode HTML. */
export const escHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Text for SVG/XML, safe inside attribute values too. */
export const escXml = (t: string) => escHtml(t).replace(/"/g, '&quot;');
