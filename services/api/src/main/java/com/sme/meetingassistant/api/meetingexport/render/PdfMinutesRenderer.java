package com.sme.meetingassistant.api.meetingexport.render;

import com.sme.meetingassistant.api.meetingminutes.MinutesSnapshot;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.text.Normalizer;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Service;

/**
 * DE-08: offline, bounded, text-only Unicode PDF from the DE-07 approved
 * Markdown representation of an immutable DE-05 MinutesSnapshot.
 *
 * No user-authored HTML, script, URI or template is ever interpreted.
 * The renderer does no network, JDBC, filesystem, AI or storage access.
 * Current-content authorization and object verification belong to DE-09/10.
 */
@Service
public final class PdfMinutesRenderer {
    public static final String VERSION = "pdf-v1-markdown-v1-dejavu-2.29";
    private static final float W = PDRectangle.A4.getWidth();
    private static final float H = PDRectangle.A4.getHeight();
    private static final float MARGIN = 49;
    private static final float MIN_Y = 58;
    private static final float WIDTH = W - 2 * MARGIN;
    private static final int MAX_PAGES = 300;
    private static final int MAX_BYTES = 32 * 1024 * 1024;
    private final MarkdownMinutesRenderer markdownRenderer;
    private final byte[] fontBytes;

    public PdfMinutesRenderer(MarkdownMinutesRenderer markdownRenderer) {
        this.markdownRenderer = Objects.requireNonNull(markdownRenderer);
        this.fontBytes = bundledFont();
    }

    private static byte[] bundledFont() {
        try {
            Resource[] fonts = new PathMatchingResourcePatternResolver()
                    .getResources("classpath*:**/DejaVuSans.ttf");
            if (fonts.length != 1 || !fonts[0].exists()) {
                throw new IllegalStateException(
                        "Exactly one bundled DejaVuSans.ttf is required; found " + fonts.length);
            }
            try (InputStream stream = fonts[0].getInputStream()) {
                byte[] data = stream.readNBytes(3 * 1024 * 1024 + 1);
                if (data.length < 1000 || data.length > 3 * 1024 * 1024) {
                    throw new IllegalStateException("Bundled font size invalid");
                }
                return data;
            }
        } catch (IOException e) {
            throw new IllegalStateException("Bundled Vietnamese font cannot be loaded", e);
        }
    }

    public RenderedPdf render(MinutesSnapshot snapshot) {
        RenderedMarkdown source = markdownRenderer.render(
                Objects.requireNonNull(snapshot, "snapshot"));
        try (PDDocument pdf = new PDDocument()) {
            PDDocumentInformation metadata = new PDDocumentInformation();
            metadata.setTitle("Bien ban cuoc hop - SME Meeting Assistant");
            metadata.setCreator("SME Meeting Assistant");
            metadata.setProducer("SME Meeting Assistant " + VERSION);
            metadata.setSubject("Source fingerprint: " + source.sourceFingerprint());
            pdf.setDocumentInformation(metadata);
            PDType0Font font = PDType0Font.load(
                    pdf, new ByteArrayInputStream(fontBytes), true);
            Layout layout = new Layout(pdf, font);
            try {
                for (String line : source.text().split("\n", -1)) {
                    layout.add(line);
                }
            } finally {
                layout.close();
            }
            footer(pdf, font);
            var stream = new ByteArrayOutputStream(16_384);
            pdf.save(stream);
            if (stream.size() > MAX_BYTES) {
                throw new IllegalArgumentException("PDF exceeds 32 MiB");
            }
            return new RenderedPdf(stream.toByteArray(), source.sourceFingerprint(),
                    VERSION, pdf.getNumberOfPages());
        } catch (IOException e) {
            throw new IllegalStateException("Canonical Minutes PDF rendering failed", e);
        }
    }

    private static void footer(PDDocument pdf, PDType0Font font) throws IOException {
        int total = pdf.getNumberOfPages();
        for (int i = 0; i < total; i++) {
            try (PDPageContentStream stream = new PDPageContentStream(pdf, pdf.getPage(i),
                    PDPageContentStream.AppendMode.APPEND, true, true)) {
                stream.setLineWidth(0.6f);
                stream.setStrokingColor(190, 190, 190);
                stream.moveTo(MARGIN, 46);
                stream.lineTo(W - MARGIN, 46);
                stream.stroke();
                print(stream, font, "SME Meeting Assistant | Bien ban", MARGIN, 30, 8, 95);
                String page = "Trang " + (i + 1) + " / " + total;
                float width = font.getStringWidth(page) * 8 / 1000;
                print(stream, font, page, W - MARGIN - width, 30, 8, 95);
            }
        }
    }

    private static void print(PDPageContentStream stream, PDType0Font font,
            String value, float x, float y, float size, int gray) throws IOException {
        if (value.isEmpty()) return;
        stream.beginText();
        stream.setFont(font, size);
        stream.setNonStrokingColor(gray, gray, gray);
        stream.newLineAtOffset(x, y);
        stream.showText(value);
        stream.endText();
    }

    private enum Style {
        TITLE(18, 25, 15, 35),
        SECTION(13, 19, 12, 38),
        SUBHEADING(11.1f, 17, 8, 48),
        BODY(10.2f, 15.2f, 3, 45),
        QUOTE(10.1f, 15.2f, 1, 68),
        WARNING(10.1f, 16, 5, 34),
        SMALL(9.7f, 14.8f, 2, 90);

        final float size, leading, before;
        final int gray;
        Style(float size, float leading, float before, int gray) {
            this.size = size; this.leading = leading;
            this.before = before; this.gray = gray;
        }
    }

    /** Only interprets static layout tokens emitted by DE-07, never arbitrary HTML. */
    private static final class Layout implements AutoCloseable {
        private final PDDocument pdf;
        private final PDType0Font font;
        private final Map<Integer, String> glyphCache = new HashMap<>();
        private PDPageContentStream stream;
        private float y;
        private int lineCount;

        Layout(PDDocument pdf, PDType0Font font) throws IOException {
            this.pdf = pdf;
            this.font = font;
            newPage();
        }

        void add(String raw) throws IOException {
            if (raw.isBlank()) {
                y -= 4.5f;
                return;
            }
            Style style;
            String text;
            if (raw.startsWith("### ")) {
                style = Style.SUBHEADING; text = raw.substring(4);
            } else if (raw.startsWith("## ")) {
                style = Style.SECTION; text = raw.substring(3);
            } else if (raw.startsWith("# ")) {
                style = Style.TITLE; text = raw.substring(2);
            } else if (raw.startsWith("> ")) {
                style = Style.QUOTE; text = raw.substring(2);
            } else if (raw.startsWith("**CẢNH BÁO") || raw.startsWith("- **Cảnh báo")) {
                style = Style.WARNING; text = raw;
            } else if (raw.startsWith("- ")) {
                style = Style.BODY; text = raw.substring(2);
            } else if (raw.startsWith("*")) {
                style = Style.SMALL; text = raw;
            } else {
                style = Style.BODY; text = raw;
            }
            String plain = glyphText(unescape(text));
            if (style == Style.QUOTE) plain = "  " + plain;
            if (style == Style.BODY) plain = "- " + plain;
            wrapped(plain, style);
        }

        private void wrapped(String text, Style style) throws IOException {
            if (text.isEmpty()) return;
            float room = WIDTH - (style == Style.QUOTE ? 12 : 0);
            float x = MARGIN + (style == Style.QUOTE ? 12 : 0);
            var lines = new java.util.ArrayList<String>();
            StringBuilder wordLine = new StringBuilder();
            float used = 0;
            for (String word : text.split(" +")) {
                if (word.isEmpty()) continue;
                float wordWidth = width(word, style.size);
                if (used > 0 && used + width(" ", style.size) + wordWidth > room) {
                    lines.add(wordLine.toString());
                    wordLine.setLength(0);
                    used = 0;
                }
                if (wordWidth <= room) {
                    if (used > 0) {
                        wordLine.append(' '); used += width(" ", style.size);
                    }
                    wordLine.append(word); used += wordWidth;
                } else {
                    // Split long unbroken tokens at Unicode codepoint boundaries.
                    for (int at = 0; at < word.length();) {
                        int cp = word.codePointAt(at);
                        String character = new String(Character.toChars(cp));
                        at += Character.charCount(cp);
                        float next = width(character, style.size);
                        if (used > 0 && used + next > room) {
                            lines.add(wordLine.toString());
                            wordLine.setLength(0);
                            used = 0;
                        }
                        wordLine.append(character); used += next;
                    }
                }
            }
            if (!wordLine.isEmpty()) lines.add(wordLine.toString());
            if (lines.isEmpty()) return;
            reserve(style.before + style.leading * Math.min(2, lines.size()));
            y -= style.before;
            for (String line : lines) {
                reserve(style.leading);
                if (++lineCount > 20_000) {
                    throw new IllegalArgumentException("PDF line count exceeds safety cap");
                }
                print(stream, font, line, x, y, style.size, style.gray);
                y -= style.leading;
            }
        }

        private float width(String value, float fontSize) throws IOException {
            return font.getStringWidth(value) * fontSize / 1000f;
        }

        private String glyphText(String input) throws IOException {
            String text = Normalizer.normalize(input, Normalizer.Form.NFC);
            StringBuilder visible = new StringBuilder(text.length());
            for (int at = 0; at < text.length();) {
                int cp = text.codePointAt(at);
                at += Character.charCount(cp);
                String mapped = glyphCache.get(cp);
                if (mapped == null) {
                    String candidate = new String(Character.toChars(cp));
                    try {
                        if (Character.isISOControl(cp)
                                || Character.getType(cp) == Character.FORMAT) {
                            throw new IllegalArgumentException("Invisible source control");
                        }
                        font.getStringWidth(candidate);
                        mapped = candidate;
                    } catch (IllegalArgumentException ex) {
                        // Unsupported emoji/script must remain visibly traceable.
                        mapped = "[U+" + Integer.toHexString(cp)
                                .toUpperCase(java.util.Locale.ROOT) + "]";
                    }
                    glyphCache.put(cp, mapped);
                }
                visible.append(mapped);
            }
            return visible.toString();
        }

        private static String unescape(String input) {
            // Escapes were produced by the trusted DE-07 renderer.
            String noEmphasis = input.replace("**", "");
            if (noEmphasis.length() >= 2 && noEmphasis.startsWith("*")
                    && noEmphasis.endsWith("*")) {
                noEmphasis = noEmphasis.substring(1, noEmphasis.length() - 1);
            }
            StringBuilder out = new StringBuilder(noEmphasis.length());
            for (int i = 0; i < noEmphasis.length(); i++) {
                char c = noEmphasis.charAt(i);
                if (c == '\\' && i + 1 < noEmphasis.length()
                        && "\\*_{}[]()#+-.!|~".indexOf(noEmphasis.charAt(i + 1)) >= 0) {
                    out.append(noEmphasis.charAt(++i));
                } else {
                    out.append(c);
                }
            }
            return out.toString()
                    .replace("&lt;", "<").replace("&gt;", ">")
                    .replace("&quot;", "\"").replace("&amp;", "&");
        }

        private void reserve(float height) throws IOException {
            if (y - height < MIN_Y) newPage();
        }

        private void newPage() throws IOException {
            if (pdf.getNumberOfPages() >= MAX_PAGES) {
                throw new IllegalArgumentException("PDF exceeds 300-page limit");
            }
            close();
            PDPage page = new PDPage(PDRectangle.A4);
            pdf.addPage(page);
            stream = new PDPageContentStream(pdf, page);
            y = H - MARGIN - 9;
            stream.setLineWidth(0.6f);
            stream.setStrokingColor(215, 215, 215);
            stream.moveTo(MARGIN, H - 38);
            stream.lineTo(W - MARGIN, H - 38);
            stream.stroke();
        }

        @Override public void close() throws IOException {
            if (stream != null) {
                stream.close();
                stream = null;
            }
        }
    }
}
