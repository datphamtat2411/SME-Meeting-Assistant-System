package com.sme.meetingassistant.api.media.worker;

import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Set;
import java.util.UUID;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Worker-scoped parser. Public API Jackson compatibility is deliberately unaffected. */
public final class WorkerJson {
    public static final JsonMapper MAPPER = JsonMapper.builder()
        .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private WorkerJson() {}
    public static JsonNode parse(byte[] bytes, int maximum) {
        if (bytes.length > maximum) throw new WorkerException(413, "VALIDATION_ERROR");
        try {
            var text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            require(!text.startsWith("\ufeff"));
            var node = MAPPER.readTree(text);
            require(node != null && node.isObject());
            return node;
        } catch (WorkerException e) { throw e; }
        catch (Exception e) { throw invalid(); }
    }
    public static void fields(JsonNode n, String... names) {
        require(n != null && n.isObject() && n.size() == names.length);
        Set<String> expected = Set.of(names);
        n.properties().forEach(p -> require(expected.contains(p.getKey())));
    }
    public static String string(JsonNode n, String name, int max) {
        var v = n.get(name);
        require(v != null && v.isString());
        String text = v.asString();
        require(!text.codePoints().allMatch(cp -> Character.isWhitespace(cp) || Character.isSpaceChar(cp))
            && text.codePointCount(0,text.length()) <= max);
        for (int i=0;i<text.length();) {
            char c=text.charAt(i);
            require(!Character.isSurrogate(c) || Character.isHighSurrogate(c)
                && i+1<text.length() && Character.isLowSurrogate(text.charAt(i+1)));
            int cp=text.codePointAt(i); i+=Character.charCount(cp);
            require((Character.getType(cp)!=Character.CONTROL && Character.getType(cp)!=Character.FORMAT)
                || cp=='\r' || cp=='\n' || cp=='\t');
        }
        return text;
    }
    public static String token(JsonNode n, String name, int max) {
        String s=string(n,name,max);
        require(s.matches("[A-Za-z0-9][A-Za-z0-9_.:/-]*") && !s.contains("://") && !s.contains(".."));
        return s;
    }
    public static UUID uuid(JsonNode n,String name) {
        String s=string(n,name,36);
        require(s.matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"));
        return UUID.fromString(s);
    }
    public static long number(JsonNode n,String name,long min,long max) {
        var v=n.get(name);
        require(v!=null && v.isIntegralNumber() && v.canConvertToLong());
        long value=v.longValue(); require(value>=min && value<=max); return value;
    }
    public static boolean bool(JsonNode n,String name) {
        var v=n.get(name); require(v!=null && v.isBoolean()); return v.booleanValue();
    }
    public static String digest(JsonNode n,String name) {
        String s=string(n,name,64); require(s.matches("[a-f0-9]{64}")); return s;
    }
    public static String choice(JsonNode n,String name,String... choices) {
        String s=string(n,name,96); require(Set.of(choices).contains(s)); return s;
    }
    public static JsonNode array(JsonNode n,String name,int min,int max) {
        var v=n.get(name); require(v!=null && v.isArray() && v.size()>=min && v.size()<=max); return v;
    }
    public static void require(boolean condition) { if (!condition) throw invalid(); }
    private static WorkerException invalid() { return new WorkerException(422,"VALIDATION_ERROR"); }
    public static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException("SHA-256 unavailable"); }
    }
}
