package com.sme.meetingassistant.api.assistant;

/** Isolated authenticated AI answer port; no caller-controlled host, URL or identity. */
public interface AssistantAiGateway {
    String answer(String jsonRequest) throws Exception;
}
