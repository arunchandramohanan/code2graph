package com.acme.shop.service;

import com.acme.shop.dto.OrderDto;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.Async;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class NotificationService {

    private final KafkaTemplate<String, String> kafkaTemplate;

    public NotificationService(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    @Async
    public void sendOrderConfirmation(OrderDto order) {
        kafkaTemplate.send("order-confirmations", String.valueOf(order.id()));
    }

    @Scheduled(cron = "0 0 8 * * *")
    public void sendDailyDigest() {
        kafkaTemplate.send("daily-digest", "digest");
    }

    @KafkaListener(topics = "payment-events")
    public void onPaymentEvent(String payload) {
        // react to payments from the payment system
    }
}
