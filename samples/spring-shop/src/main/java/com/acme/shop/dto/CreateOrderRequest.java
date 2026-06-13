package com.acme.shop.dto;

import java.util.List;

public record CreateOrderRequest(Long customerId, List<OrderItemDto> items) {}
