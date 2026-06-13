package com.acme.shop.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

public record OrderDto(Long id, Instant placedAt, BigDecimal total, String status,
                       String customerName, List<OrderItemDto> items) {}
