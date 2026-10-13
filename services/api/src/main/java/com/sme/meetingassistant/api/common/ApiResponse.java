package com.sme.meetingassistant.api.common;

import com.fasterxml.jackson.annotation.JsonInclude;
import io.swagger.v3.oas.annotations.media.Schema;
import java.util.List;

@Schema(description = "The common response envelope for ordinary API responses.")
public record ApiResponse<T>(
		boolean success,
		String code,
		String message,
		@Schema(nullable = true) @JsonInclude(JsonInclude.Include.ALWAYS) T data,
		ApiMeta meta,
		@JsonInclude(JsonInclude.Include.NON_EMPTY) List<ApiFieldError> errors) {

	public ApiResponse {
		if (errors != null) {
			errors = List.copyOf(errors);
		}
	}

}
