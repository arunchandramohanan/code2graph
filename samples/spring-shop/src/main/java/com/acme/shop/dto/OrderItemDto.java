package com.acme.shop.dto;

import java.math.BigDecimal;

public record OrderItemDto(String productName, int quantity, BigDecimal unitPrice) {}
