package com.acme.shop.service;

import com.acme.shop.domain.Order;
import com.acme.shop.domain.OrderStatus;
import com.acme.shop.dto.CreateOrderRequest;
import com.acme.shop.dto.OrderDto;
import com.acme.shop.dto.OrderItemDto;
import com.acme.shop.repository.OrderRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.List;

@Service
public class OrderService {

    private final OrderRepository orderRepository;
    private final CustomerService customerService;

    public OrderService(OrderRepository orderRepository, CustomerService customerService) {
        this.orderRepository = orderRepository;
        this.customerService = customerService;
    }

    public List<OrderDto> findAll() {
        return orderRepository.findAll().stream().map(this::toDto).toList();
    }

    public OrderDto findById(Long id) {
        return orderRepository.findById(id).map(this::toDto).orElseThrow();
    }

    public List<OrderDto> findForCustomer(Long customerId) {
        customerService.ensureExists(customerId);
        return orderRepository.findRecentByCustomer(customerId).stream().map(this::toDto).toList();
    }

    @Transactional
    public OrderDto create(CreateOrderRequest request) {
        Order order = new Order();
        order.setStatus(OrderStatus.NEW);
        return toDto(orderRepository.save(order));
    }

    @Transactional
    public void cancel(Long id) {
        Order order = orderRepository.findById(id).orElseThrow();
        order.setStatus(OrderStatus.CANCELLED);
        orderRepository.save(order);
    }

    private OrderDto toDto(Order order) {
        List<OrderItemDto> items = order.getItems().stream()
            .map(i -> new OrderItemDto(i.getProductName(), i.getQuantity(), i.getUnitPrice()))
            .toList();
        String customerName = order.getCustomer() != null ? order.getCustomer().getFullName() : "";
        return new OrderDto(order.getId(), order.getPlacedAt(), order.getTotal(),
            String.valueOf(order.getStatus()), customerName, items);
    }
}
