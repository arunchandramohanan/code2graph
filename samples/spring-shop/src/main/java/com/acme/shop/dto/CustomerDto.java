package com.acme.shop.dto;

public record CustomerDto(Long id, String fullName, String email, int orderCount) {}
