// Wide repeated result trees stress selectors/text extraction while staying
// within the runtime's 2 MB input cap. Synthetic: no live HTML or credentials.
export const pathologicalHtml = '<title>Kagi Search</title>' + '<div class="search-result"><section><a class="__sri_title_link" href="https://example.test/">Safe</a><div class="__sri-desc"><b>nested</b> text</div></section></div>'.repeat(11000);
