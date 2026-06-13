package com.acme.shop.repository;

import com.acme.shop.domain.Order;
import com.acme.shop.domain.OrderStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import java.util.List;

@Repository
public interface OrderRepository extends JpaRepository<Order, Long> {

    List<Order> findByStatus(OrderStatus status);

    @Query("select o from Order o where o.customer.id = :customerId order by o.placedAt desc")
    List<Order> findRecentByCustomer(@Param("customerId") Long customerId);
}
