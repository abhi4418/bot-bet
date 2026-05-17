fetch("https://catalog.uvwin2024.co/catalog/v2/sports-feed/sports/live-events?providerId=BetFair", {
  "headers": {
    "accept": "application/json",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8,hi;q=0.7",
    "authorization": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJvd25lciI6ImFiaGlnZ3FvMSIsInN1YiI6ImFiaGlnZ3FvMSIsImN1ciI6MywiaGlkIjoxNiwicm9sZSI6IlVzZXIiLCJzYXAiOiIiLCJwZXJtIjo0LCJvcmciOiJjcnlwdG8yNDcuY2x1YiIsImlzcyI6ImFsdGdhbWUuYXBwIiwibHQiOiJQQVNTIiwicGlkIjo5OTY2Mjk3NDAyLCJhZmZQYXRoIjoiIiwibW9kZSI6Ik9OTElORSIsImF1ZCI6InJvbGV4LmNvbSIsInVpZCI6MTA0MTUyNDU1OTcsInBhdGgiOiJIQS8xNi9TRE0vOTkwOTkzMjg1MC9TTS85OTY0NDkyNzAzL0EvOTk2NjI5NzQwMi9VLzEwNDE1MjQ1NTk3Iiwic3RzIjoxLCJhbGlhcyI6ImFiaGlnZ3FvMV8xNiIsImN0aW1lIjoxNzUwMjQxMDM3LCJwYXltZW50UGVybSI6MCwiZXhwIjoxNzc5MDM4NjExLCJpYXQiOjE3NzkwMDk4MTEsImFpZCI6MTA0MTUyNDU1OTd9.tzs4Hs6hzuC5XDMhvrD5qBclJCgUZ_MfHa0PKarxeoZid-HrboRX6SVeZVKwO3szEUj-F7-aM8FOCINCbJyzOg",
    "priority": "u=1, i",
    "sec-ch-ua": "\"Google Chrome\";v=\"141\", \"Not?A_Brand\";v=\"8\", \"Chromium\";v=\"141\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "sec-gpc": "1",
    "Referer": "https://www.crypto247.club/"
  },
  "body": null,
  "method": "GET"
});

this is the fetch url to get the live events
we need to use this api to fetch the events , we will
be moving away from bot telegram to user telegram 
i will be giving you app_id and api_hash to connect to telegram

we want the bot to read the messages from a specefic channel
and place bets and after placing bets it should be sending updates on a group where i will be present with some other people

we may also additionally send messages in that group that can also lead to betting and placing bets


["SUBSCRIBE\nid:sub-0\ndestination:/topic/betfair_match_odds_update/35616900/1.258274195\n\n\u0000"]

currently we are subscribing to bookmaker event , now we will be
using the above events to fetch live odds in realtime

the main job of the bot is to place bets by reading from the channel

we will be hard coding 1 limit value in our program and we will also store all the bets placed for that event in memory

whenever we say cashout we should have some math running that would be calculating amount and side that would lead to getting almost equal amount on both sides be it negative or positive 
this will be called CASHOUT