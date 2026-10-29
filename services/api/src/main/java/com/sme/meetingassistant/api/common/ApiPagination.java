package com.sme.meetingassistant.api.common;

import org.springframework.data.domain.Page;

/** Authorization-filtered totals; use only after the visibility predicate has been applied. */
public record ApiPagination(int page, int size, long totalElements, int totalPages,
                            boolean hasNext, boolean hasPrevious) {
    public static ApiPagination from(Page<?> result) {
        return new ApiPagination(result.getNumber(), result.getSize(), result.getTotalElements(),
            result.getTotalPages(), result.hasNext(), result.hasPrevious());
    }
}
