package com.sme.meetingassistant.api.meetingintelligence.service;

import java.util.List;
import java.util.Set;

/** Fixed-size, allowlisted result warnings; not evidence of transcript correctness. */
public final class AiQualityMetadata {
    private static final Set<String> ALLOWED=Set.of("INCOMPLETE_COVERAGE",
        "UNRESOLVED_EVIDENCE","SUSPICIOUS_EVIDENCE","SOURCE_QUALITY_WARNING");
    private AiQualityMetadata() {}

    /** PostgreSQL array literal: safe because every element is an exact enum token. */
    public static String pgArray(List<String> codes) {
        if(codes==null || codes.size()>4 || codes.stream().anyMatch(c->!ALLOWED.contains(c))
                || codes.stream().distinct().count()!=codes.size())
            throw new IllegalArgumentException("Invalid AI warning codes.");
        return "{" + String.join(",",codes) + "}";
    }

    /** SQL array_to_string() over allowlisted codes; never parse arbitrary text. */
    public static List<String> fromCsv(String codes) {
        if(codes==null || codes.isEmpty()) return List.of();
        List<String> value=List.of(codes.split(",",-1));
        if(value.size()>4 || value.stream().anyMatch(c->!ALLOWED.contains(c))
                || value.stream().distinct().count()!=value.size())
            throw new IllegalStateException("Corrupt persisted AI quality metadata.");
        return value;
    }
}
