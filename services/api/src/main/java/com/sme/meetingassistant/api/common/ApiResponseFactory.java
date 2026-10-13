package com.sme.meetingassistant.api.common;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class ApiResponseFactory {

	private static final String DEFAULT_SUCCESS_MESSAGE = "Request completed successfully.";

	public <T> ApiResponse<T> success(T data) {
		return success(DEFAULT_SUCCESS_MESSAGE, data);
	}

	public <T> ApiResponse<T> success(String message, T data) {
		return new ApiResponse<>(true, ApiErrorCode.SUCCESS.name(), message, data, metadata(), null);
	}

	public <T> ApiResponse<T> error(ApiErrorCode code, String message) {
		return error(code.name(), message, null);
	}

	public <T> ApiResponse<T> error(ApiErrorCode code, String message, List<ApiFieldError> errors) {
		return error(code.name(), message, errors);
	}

	public <T> ApiResponse<T> error(String code, String message, List<ApiFieldError> errors) {
		return new ApiResponse<>(false, code, message, null, metadata(), errors);
	}

	private static ApiMeta metadata() {
		return new ApiMeta(RequestIdContext.currentRequestId(), OffsetDateTime.now(ZoneOffset.UTC));
	}

}
