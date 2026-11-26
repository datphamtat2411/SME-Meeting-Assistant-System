package com.sme.meetingassistant.api.assistant;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Stable public outcomes for distinct Assistant business conflicts. */
final class AssistantDomainException extends ResponseStatusException {
    private final String code;

    AssistantDomainException(HttpStatus status,String code,String message) {
        super(status,message);
        this.code=code;
    }

    String code(){return code;}
}
