package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.sme.meetingassistant.api.common.ApiErrorCode;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.exception.ApiExceptionHandler;
import com.sme.meetingassistant.api.exception.Http500DiagnosticLogger;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class IntelligencePreconditionErrorTests {
    @Test
    void missingIfMatchUsesStandardSanitizedEnvelopeNotGenericClientError() {
        var handler = new ApiExceptionHandler(new ApiResponseFactory(), mock(Http500DiagnosticLogger.class));
        var response = handler.handle(new ResponseStatusException(HttpStatus.PRECONDITION_REQUIRED));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.PRECONDITION_REQUIRED);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().success()).isFalse();
        assertThat(response.getBody().code()).isEqualTo(ApiErrorCode.PRECONDITION_REQUIRED.name());
        assertThat(response.getBody().message()).isEqualTo("A request precondition is required.");
    }
}
