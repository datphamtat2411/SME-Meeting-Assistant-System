package com.sme.meetingassistant.api.observability;

import org.slf4j.MDC;

public final class RequestIdContext {

	public static final String HEADER_NAME = "X-Request-Id";
	public static final String MDC_KEY = "requestId";
	public static final String REQUEST_ID_ATTRIBUTE = RequestIdContext.class.getName() + ".requestId";

	private RequestIdContext() {
	}

	public static String currentRequestId() {
		return MDC.get(MDC_KEY);
	}

	public static void setCurrentRequestId(String requestId) {
		if (requestId == null) {
			MDC.remove(MDC_KEY);
		}
		else {
			MDC.put(MDC_KEY, requestId);
		}
	}

	public static void restore(String requestId) {
		setCurrentRequestId(requestId);
	}

}
