package com.sme.meetingassistant.api.common;

import io.swagger.v3.oas.annotations.media.Schema;

public record ApiFieldError(
		@Schema(description = "The client-visible field or parameter name.") String field,
		@Schema(description = "The normalized machine-readable validation code.") String code,
		@Schema(description = "A safe human-readable validation message.") String message) {
}
