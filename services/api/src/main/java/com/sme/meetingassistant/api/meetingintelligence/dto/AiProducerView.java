package com.sme.meetingassistant.api.meetingintelligence.dto;

/** AI-supplied, validated producer attribution, never permission or authority. */
public record AiProducerView(String provider, String model, String promptVersion) {
    public static AiProducerView nullable(String provider,String model,String promptVersion) {
        return model==null ? null : new AiProducerView(provider,model,promptVersion);
    }
}
