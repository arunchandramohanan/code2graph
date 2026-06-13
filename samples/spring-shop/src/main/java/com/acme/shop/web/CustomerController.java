package com.acme.shop.web;

import com.acme.shop.dto.CustomerDto;
import com.acme.shop.dto.OrderDto;
import com.acme.shop.service.CustomerService;
import com.acme.shop.service.OrderService;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/customers")
public class CustomerController {

    private final CustomerService customerService;
    private final OrderService orderService;

    public CustomerController(CustomerService customerService, OrderService orderService) {
        this.customerService = customerService;
        this.orderService = orderService;
    }

    @GetMapping
    public List<CustomerDto> list() {
        return customerService.findAll();
    }

    @GetMapping("/{id}")
    public CustomerDto get(@PathVariable Long id) {
        return customerService.findById(id);
    }

    @GetMapping("/{id}/orders")
    public List<OrderDto> orders(@PathVariable Long id) {
        return orderService.findForCustomer(id);
    }
}
