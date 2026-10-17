package com.sme.meetingassistant.api.common;

public record PaginationMeta(
		int page,
		int size,
		long totalElements,
		int totalPages) {
}
