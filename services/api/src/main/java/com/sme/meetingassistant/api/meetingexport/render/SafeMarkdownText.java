package com.sme.meetingassistant.api.meetingexport.render;

/**
 * Untrusted meeting, human and AI content is always treated as text, never
 * author-controlled Markdown/HTML structure or remotely resolved resources.
 */
final class SafeMarkdownText {
    private static final int MAX_FIELD_CODE_UNITS = 1_048_576;

    private SafeMarkdownText() { }

    /** Inlines have no caller-controlled line breaks or raw markup. */
    static String inline(String value) {
        if (value == null) return "";
        String source = normalize(value);
        var out = new StringBuilder(source.length() + 16);
        for (int offset = 0; offset < source.length();) {
            int cp = source.codePointAt(offset);
            offset += Character.charCount(cp);
            if (cp == '\n') {
                out.append(' ');
            } else if (cp == '&') {
                out.append("&amp;");
            } else if (cp == '<') {
                out.append("&lt;");
            } else if (cp == '>') {
                out.append("&gt;");
            } else if (cp == '"') {
                out.append("&quot;");
            } else if (cp == '\\' || cp == 0x60 || cp == '*' || cp == '_'
                    || cp == '{' || cp == '}' || cp == '[' || cp == ']'
                    || cp == '(' || cp == ')' || cp == '#' || cp == '+'
                    || cp == '-' || cp == '.' || cp == '!' || cp == '|'
                    || cp == '~') {
                out.append('\\').appendCodePoint(cp);
            } else {
                out.appendCodePoint(cp);
            }
        }
        return out.toString();
    }

    /** Every long-form line remains inside a controlled, escaped blockquote. */
    static void quote(StringBuilder out, String input) {
        if (input == null || input.isBlank()) {
            out.append("> *Chưa có nội dung.*\n\n");
            return;
        }
        for (String line : normalize(input).split("\n", -1)) {
            out.append("> ").append(inline(line)).append('\n');
        }
        out.append('\n');
    }

    private static String normalize(String text) {
        if (text.length() > MAX_FIELD_CODE_UNITS) {
            throw new IllegalArgumentException("Source field exceeds 1 Mi UTF-16 code units");
        }
        var out = new StringBuilder(text.length());
        for (int offset = 0; offset < text.length();) {
            int cp = text.codePointAt(offset);
            offset += Character.charCount(cp);
            if (cp == '\r') {
                if (offset < text.length() && text.charAt(offset) == '\n') offset++;
                out.append('\n');
            } else if (cp == '\n' || cp == 0x85 || cp == 0x2028 || cp == 0x2029) {
                out.append('\n');
            } else if (cp == '\t') {
                out.append(' ');
            } else if (cp < 0x20 || cp == 0x7f || cp >= 0x80 && cp <= 0x9f
                    || cp >= 0x202a && cp <= 0x202e
                    || cp >= 0x2066 && cp <= 0x2069) {
                // Control-sequence and bidirectional-isolation spoofing prevention.
                out.append('\ufffd');
            } else {
                out.appendCodePoint(cp);
            }
        }
        return out.toString();
    }
}
