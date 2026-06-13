package com.acme.shop.service;

import com.acme.shop.domain.Customer;
import com.acme.shop.dto.CustomerDto;
import com.acme.shop.repository.CustomerRepository;
import org.springframework.stereotype.Service;
import java.util.List;

@Service
public class CustomerService {

    private final CustomerRepository customerRepository;

    public CustomerService(CustomerRepository customerRepository) {
        this.customerRepository = customerRepository;
    }

    public List<CustomerDto> findAll() {
        return customerRepository.findAll().stream().map(this::toDto).toList();
    }

    public CustomerDto findById(Long id) {
        return customerRepository.findById(id).map(this::toDto).orElseThrow();
    }

    public void ensureExists(Long id) {
        if (!customerRepository.existsById(id)) {
            throw new IllegalArgumentException("no customer " + id);
        }
    }

    private CustomerDto toDto(Customer c) {
        return new CustomerDto(c.getId(), c.getFullName(), c.getEmail(), c.getOrders().size());
    }
}
